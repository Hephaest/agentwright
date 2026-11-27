---
name: agent-build-context
description: "Decide what each model request carries and where state is stored: system prompt, session history, memory, caching. Use when writing a system prompt, resuming a thread, adding memory or trimming history."
user-invocable: false
---

# Agent Context and State

The model is a function of what your code sends on this turn. It remembers nothing between requests, so everything an agent seems to know arrived in a request your code built. Build every request from stored state, scoped to one tenant, with a stable start and an append-only end.

## Prerequisites

- A working loop (model call, tool call, tool result, exits). Build it first with agent-build-loop.
- For the exact API of an SDK, framework or vendor feature, look up its current documentation with your documentation lookup tool instead of trusting memory or the dated notes in [references/long-history.md](references/long-history.md).

## What a request holds

A request is one model call. It has three parts: the system prompt, the tool definitions, and the messages (the history of turns). Each part has exactly one source in your code.

| Part | Holds | Where your code gets it | Changes |
|---|---|---|---|
| System prompt | Role, goal, rules, output shape, memory index | A constant, plus the tenant's memory index loaded at run start | Never within a run |
| Tool definitions | Name, description and input schema of each tool | A constant list, in a fixed order | Never within a run |
| First message | The task: a ticket id, a user's question | The trigger event | Never |
| Middle messages | Earlier replies, tool calls and tool results | The thread's send list in your session store | Grows at the end only |
| Newest message | This turn's tool result, or a person's new message | Your tool runner, or the new event | New each turn |

- **Never in the request** — API keys, tokens, database clients, permission checks and any other tenant's data. They live in the run context: the object your code passes to tool handlers and never serializes. OpenAI's Agents SDK docs put it this way: "Conversation history is what the model sees. Run context is what your code sees."
- **Tenant isolation is non-negotiable** — a tenant is one customer workspace or account. Your code takes the tenant id from the verified trigger event and keeps it in the run context. Every read and write of thread, memory and pending rows filters by it in code. No tool takes a tenant argument, and nothing the model writes can choose or change it.
- **Untrusted text goes in messages, never in the system prompt** — ticket bodies, web pages, emails and memory entries are data. OpenAI: "Don't use untrusted variables in developer messages." Injection defenses belong to agent-harden-guardrails.
- **Fewest tokens that do the job** — Anthropic: "Context must be treated as a finite resource with diminishing marginal returns." Fetch large data just in time through a tool instead of loading it up front.

## System prompt

Anthropic places the right prompt between two failures: "hardcoding complex, brittle logic" and "vague, high-level guidance" ([source](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). A good default names four things:

- **Role** — who the agent is and whom it serves, in one sentence.
- **Goal** — the decision or artifact one run must produce.
- **Rules** — a few firm rules the agent can follow with its tools, such as which tool comes first and what counts as evidence.
- **Output shape** — how the run ends, such as one final tool call with named, typed fields (agent-build-tools owns that tool).

Keep clock time, run ids, request ids and per-user greetings out of it, because they change the start of every request (see Cache-friendly ordering).

System prompt for the triage example agent (a sketch, not run):

```text
You triage new support tickets for the support team.
Goal: decide whether the reported problem is real, why it happens, and who should fix it.

Rules:
- Read the ticket with get_ticket, then call search_similar_tickets before you decide.
- Every claim cites evidence: file:line from search_code, or a past ticket id.
- If the evidence is thin, the verdict is NEEDS_DIG. Do not guess.
- List everything you did not look at in notChecked.

Output: call post_triage once, as your last step, with verdict (CONFIRMED, REFUTED or
NEEDS_DIG), summary, evidence, suggestedOwner and notChecked.
```

## Three lifetimes of state

| Lifetime | Holds | Stored in | Keyed by | Gone when |
|---|---|---|---|---|
| This turn | The request being built, tool results, a draft answer | Process memory | Nothing | The run ends |
| This session | The thread's transcript, send list and pending action | Database rows for a service, files on one machine | Tenant id and thread id | The thread closes and its retention period ends |
| Across sessions | Facts that must outlive the thread | The system of record first (tracker, code owners file); a memory store only for the rest | Tenant id, plus user id for per-user facts | Someone deletes it, one entry at a time |

A session spans every run in one thread, including a run that starts hours later in a fresh process when a person replies. Each lifetime has its own owner and deletion rule.

## Store everything, send a view

The recommended default keeps two things per thread.

| | Transcript | Send list |
|---|---|---|
| What it is | Every message, tool call and tool result, append-only | Exactly what the next request's messages carry |
| Who reads it | You: audit, traces, debugging, evals | The model |
| With no trimming, or vendor-side clearing of tool results | The same content as the send list | The full history; the vendor trims a copy |
| After a summary (compaction) | Unchanged and complete | The summary first, then the messages after it |

- **One transaction, one version check** — write the transcript additions and the new send list together, and check a version number on the thread row on write (compare-and-set). A second run for the same thread then fails loudly instead of overwriting the first.
- **Save before the side effect that ends the run** — before asking a person and before posting the answer. Posting exactly once belongs to agent-host-remote.
- **Resume from what was last sent** — load the send list, append the new message or the tool result for the saved call id, and send with the same settings. A pause needs nothing special, because every request is rebuilt from storage.
- **A paused write is a row, not a message** — the pending action (a saved tool call waiting for a human) lives in its own row with a state machine and is never part of the request. Build it with agent-build-approval.
- **One run per thread at a time** — the run lock or lease belongs to agent-host-local or agent-host-remote. Never hold it across a human wait; the run ends at the ask.
- **One owner of conversation state** — either your store or the vendor's server-side state, per thread. OpenAI's Agents SDK docs: "pick one strategy per conversation."

## Memory

Memory is a small store of facts that your code saves in one session and loads into a later, unrelated one. A session replays one thread in full; memory holds a few distilled facts that any later thread may read. Anthropic's memory tool docs describe an agent that "records what it learns in memory files and reads them back on demand" ([source](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).

- **System of record first** — past verdicts live in the tracker and module owners in a code owners file. Query them with a tool, because a second copy drifts. Memory is for what exists nowhere else, mostly corrections from people.
- **Read: index in the prompt, full text on demand** — at run start, put one line per fact (id and topic) in the system prompt, and give the model a read tool that returns one fact in full.
- **Write: through a validated tool** — the model calls a save tool and your code checks the input before saving. Start with a tool, not automatic extraction, so every write shows in the trace and can be undone.
- **Tenant scope set by code** — the save tool's input schema has no tenant field, a strict parse rejects unknown fields, and the tenant id comes from the run context.
- **One fact per entry, with source and date** — so one fact can be corrected or deleted alone.
- **Index loaded once per run** — a fact saved mid-run appears in the index from the next run. This keeps the system prompt stable within the run.
- **Memory is untrusted input** — the OWASP Top 10 for Agentic Applications names "Memory & Context Poisoning" (ASI06): "persistent corruption of agent memory and retrievable context that propagates across sessions." Load entries as labelled data, never let an entry grant a permission, and reject secrets and over-long text on write.
- **Every model-supplied path or key is checked** — with a file store, reject any path outside the memory folder.
- **Files on one machine, rows in a service** — add a vector store or memory service only for a need you can name that rows and files do not meet. Tenant scoping stays your job either way.

Memory read and write, written against your own `Db` and `ToolResult` types (a sketch, not run):

```ts
// Run context: what your code sees. Never serialized into a request.
type RunContext = { tenantId: string; threadId: string; db: Db };
type Fact = { topic: string; text: string; source: string }; // source: who said so

// READ, once at run start. Stable order keeps the system prompt byte-identical.
async function memoryIndex(ctx: RunContext): Promise<string> {
  const facts = await ctx.db.memories.list({ tenantId: ctx.tenantId, orderBy: "id" });
  return facts.map((fact) => `- [${fact.id}] ${fact.topic}`).join("\n");
}

// WRITE, behind the save_memory tool. Its input schema has no tenant field.
async function saveMemory(ctx: RunContext, input: unknown): Promise<ToolResult> {
  const parsed = parseFact(input); // strict: unknown fields, secrets and long text rejected
  if (!parsed.ok) return { isError: true, content: parsed.error };
  await ctx.db.memories.upsert({
    key: { tenantId: ctx.tenantId, topic: parsed.fact.topic }, // topic is the fact's key: a retry overwrites
    value: { ...parsed.fact, updatedAt: new Date() },
  });
  return { isError: false, content: `Saved: ${parsed.fact.topic}` };
}
```

## One run, in order

1. **Resolve identity.** Put the tenant id and thread id from the verified event into the run context. Verifying and deduplicating events belong to agent-host-local and agent-host-remote.
2. **Load.** Read the thread row (send list and version), its pending action row if any, and the tenant's memory index.
3. **Build the request.** Use the constant system prompt plus the memory index, the constant tool definitions, then the send list plus the new message. If the send list is over budget, shorten it first with [references/long-history.md](references/long-history.md).
4. **Call the model.** This is the only step that touches the model.
5. **Branch on the reply.** Append it. For a read tool call, run it, append the result and return to step 4 within the loop's caps. For a gated write, go to step 6 with a pending row (agent-build-approval). For a final answer, go to step 6.
6. **Save, then act.** Write the transcript additions, the send list and any pending row in one transaction with the version check, then ask the person or post the answer. In long runs, also save after each model reply, so a crash loses at most one turn; read tools re-run harmlessly.

## Cache-friendly ordering

Prompt caching means the provider keeps the processed start of a request for a while, and a later request that starts with the same tokens pays far less for that part. The match is by prefix: one changed token near the start misses the cache for everything after it. The loop resends the whole history every turn, so Manus calls "the KV-cache hit rate is the single most important metric for a production-stage AI agent" and reports an average input-to-output token ratio of "around 100:1" ([source](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

- **Stable start** — system prompt and tool definitions first and byte-identical every turn: the same text, the same tool order, and JSON built with its keys in the same order.
- **Volatile facts last** — the current time, a run id or per-request data go in the newest message, never at the top.
- **Append only** — never edit or reorder earlier messages within a thread.
- **Fixed tool list for the run** — never add or remove a tool definition mid-run; answer a call that is not allowed yet with an error tool result. Manus: "avoid dynamically adding or removing tools mid-iteration." The error result's design belongs to agent-build-tools.
- **Failed calls stay in** — Manus: "Erasing failure removes evidence. And without evidence, the model can't adapt."
- **Trim rarely, in large chunks** — any clearing or summary breaks the cache from that point on, so each one must remove enough tokens to pay for the miss.
- **Measured** — log the cached and uncached input token counts the provider returns for every call, and alert when the hit rate drops.

Vendor cache controls and their costs are in the Vendor notes of [references/long-history.md](references/long-history.md).

## Long history

A growing history costs more, and the model reads it worse. Anthropic calls this context rot: "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases." Change nothing until real threads approach your token budget, then pick by what is growing.

| What is growing | Default strategy |
|---|---|
| Old tool results | Context editing: clear old tool results by rule, keep the calls |
| The conversation itself | Compaction: replace older turns with a summary |
| Work that spans sessions or days | Notes and memory: write progress to files or rows, read it back |
| One bulky side task, such as a wide search | A subagent with its own context; only its final message returns |

Mechanics, what to store, costs and vendor features are in [references/long-history.md](references/long-history.md). Whether to split work into subagents at all is decided in agent-plan-architecture.

## Checklist

- [ ] Every part of the request traces to one source in the request table, and nothing else reaches it.
- [ ] No key, token, database client, permission check or other tenant's data is serialized into a request.
- [ ] The tenant id comes from the verified event, every store query filters by it, and no tool input schema has a tenant field.
- [ ] The system prompt states role, goal, rules and output shape, with no clock time or ids.
- [ ] The transcript is append-only and kept even after a summary; the send list is saved with it in one transaction with a version check, before asking or posting.
- [ ] A resumed thread loads its send list and pending row and appends exactly one tool result for the saved call id.
- [ ] Memory puts only an index in the prompt, writes through a validated tool, and stores one fact per entry with source and date.
- [ ] Tool definitions are fixed for the run, in a fixed order, and failed calls stay in the history.
- [ ] A fake-client test that records two consecutive requests of one run passes: the system prompt and tool definitions are byte-identical, the first request's messages are an exact prefix of the second's, and a run for tenant A contains nothing from tenant B's threads or memory.

## Anti-patterns

- **Memory as one bucket** — turn state, thread state and cross-session facts have different owners and deletion rules; merging them leaks or loses data.
- **A question that lives only in the conversation** — if your code waits for an answer, your code must store the question; otherwise the next run asks again or denies that anything is pending.
- **A tenant id chosen by the model** — a tenant argument on a tool, or one parsed from message text, lets one injected sentence read another customer's data.
- **Keeping only the trimmed list** — once a summary replaces the original turns, nothing is left to audit, debug or turn into eval cases.
- **A timestamp at the top of the system prompt** — every request misses the cache for everything after it.
- **Copying the system of record into memory** — the copy drifts and the agent cites stale facts.
- **Rewriting history to hide a failed call** — the model loses the evidence it needs to try a different approach, and the cache breaks.
- **Holding a lock across a human wait** — the thread is blocked for hours, and every new message for it queues or fails.
