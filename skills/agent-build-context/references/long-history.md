# Long-history strategies

Four ways to keep a growing thread inside the token budget: context editing, compaction, notes and memory, and subagents. The vendor-neutral mechanics come first, then dated vendor notes. Every strategy changes only the send list; the transcript stays complete (see "Store everything, send a view" in SKILL.md).

- [Pick a strategy](#pick-a-strategy)
- [Before any strategy: shrink at the source](#before-any-strategy-shrink-at-the-source)
- [Context editing, done yourself](#context-editing-done-yourself)
- [Compaction, done yourself](#compaction-done-yourself)
- [Notes and memory for long tasks](#notes-and-memory-for-long-tasks)
- [Subagents](#subagents)
- [Vendor notes, as of November 2026](#vendor-notes-as-of-november-2026)

## Pick a strategy

| Strategy | What it does | Use when | What you store | What it costs |
|---|---|---|---|---|
| Context editing | Replaces old tool results with a short placeholder; the tool calls stay | Tool results dominate the tokens and can be fetched again | Nothing new; the history is unchanged and the view is computed | A cache miss from the first cleared point; the model loses cleared content unless it calls the tool again |
| Compaction | Replaces older turns with one summary written by a model | The conversation itself is long | The summary plus the turns after it, as the send list | An extra model call; detail lost in the summary; a cache miss at the swap |
| Notes and memory | The agent writes progress or facts to files or rows and reads them back | Work spans sessions or days, or must survive a fresh context | A notes file or rows, tenant-scoped like memory | Extra tool calls; notes can be wrong or poisoned |
| Subagents | A side task runs in its own context; only its final message returns | One bulky task whose intermediate results the parent never needs | The subagent's final message, as a tool result | More tokens overall; the parent cannot see the subagent's reasoning |

Anthropic's measurement of the subagent cost: "agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats" ([source](https://www.anthropic.com/engineering/multi-agent-research-system)).

Combine them by what grows. A tool-heavy loop that also runs for days uses context editing within a session and notes across sessions.

## Before any strategy: shrink at the source

- **Return only the needed fields** from each tool. Result design belongs to agent-build-tools.
- **Keep large data by reference** — return a file path, URL or id and let the model fetch the content when it needs it. Manus calls this restorable compression: drop a page's content but keep its URL, drop a document's content but keep its path ([source](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).

## Context editing, done yourself

Use this on any vendor that has no server-side clearing.

1. **Pick a trigger and a batch size.** Clear only when the estimated request size passes the trigger, and then clear at least a minimum number of tokens. Clearing a few tokens every turn moves the boundary each turn and misses the cache every turn.
2. **Store a watermark, not a new list.** Save "tool results before position N are cleared" on the thread row. The view is computed from the history and the watermark, so it is identical on every request until the next clearing. This is the recommended default.
3. **Replace the content, keep the call.** Each cleared tool result keeps its call id and becomes a placeholder that names the tool and says how to fetch the content again. Every tool call still has exactly one result.
4. **Keep the newest results.** Never clear the newest few tool results, and never clear a result that answers a call saved in a pending action row.
5. **Apply it to the view only.** The transcript and the stored history never change.

## Compaction, done yourself

1. **Trigger below the window.** Estimate the next request's size from the last response's usage counts, including cached tokens, and compact when it passes a budget you set well below the model's context window. The summary call must itself fit in the window.
2. **Never compact across an open tool call.** If the newest model reply contains a tool call with no result, append the result first. A paused thread waiting for approval resumes first, then compacts.
3. **Summarize the older part only.** Keep the most recent turns word for word. Send the same system prompt and tool definitions to the summary call, and tell it not to call tools.
4. **Name what must survive.** The summary prompt asks for the goal, decisions made, open questions, ids, file paths and URLs, and anything still pending. Images and documents in the summarized turns are gone afterward; restate or re-attach what a later turn needs.
5. **Swap in one transaction.** Write the new send list (summary first, then the kept turns) with the version check on the thread row; leave the transcript untouched. A crash before the commit leaves the old send list, which is still valid, and the next run compacts again. A second run that compacted at the same time fails the version check.
6. **Compact again from the summary.** When the thread grows long again, summarize the old summary plus everything after it, and send only the newest summary.

## Notes and memory for long tasks

- **Why** — Anthropic's long-running harness post: "each new session begins with no memory of what came before", and compaction alone "isn't sufficient." Their fix is a progress log plus git history, with each session leaving "clear artifacts for the next session" ([source](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).
- **Recitation** — Manus reports that a typical task takes "around 50 tool calls on average", and has the agent rewrite a todo file at the end of the context, "reciting its objectives into the end of the context", to keep goals in recent attention ([source](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). A later secondary report of a Manus talk says the constant rewriting used about 30% of tokens and that planning moved to a planner subagent returning a structured plan ([secondary source](https://www.philschmid.de/context-engineering-part-2)). Measure the token cost before adopting recitation.
- **Rules** — notes are memory. Tenant scoping, one entry per fact, validated writes and "memory is untrusted input" from SKILL.md all apply.

## Subagents

- A subagent runs a side task in a fresh context. Anthropic's Agent SDK docs: "only its final message returns to the parent."
- Give it a specific task and ask for a compact, structured final message. The parent stores that message as the tool result of the call that started it.
- Whether to split work this way, and the subagent and handoff mechanics, belong to agent-plan-architecture.

## Vendor notes, as of November 2026

These change often. Check current docs with your documentation lookup tool before relying on any line here.

### Anthropic (Claude API)

- **Context editing** — beta header `context-management-2025-06-27`, configured under `context_management`. It clears the oldest tool results "server-side before the prompt reaches Claude. Your client application maintains the full, unmodified conversation history. You do not need to sync your client state with the edited version." Each cleared result becomes placeholder text. A separate strategy, `clear_thinking_20251015`, clears thinking blocks from earlier turns ([source](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
- **Context editing cost** — clearing "Invalidates cached prompt prefixes when content is cleared." "You'll incur cache write costs each time content is cleared." The `clear_at_least` setting skips a clearing that would remove fewer tokens than you set. The same page says "server-side compaction is the primary strategy for managing context in long-running conversations" for most use cases.
- **Compaction, three ways** — on demand (a request with `compaction: { type: "summarize" }` and beta header `compact-2026-09-04`; it returns only a `compaction` block, with stop reason `"compaction"`), at a token threshold (an edit of type `compact_20260112`; the API drops what came before the block), and in the background. The overview says: "Use on-demand compaction wherever it is available" ([source](https://platform.claude.com/docs/en/build-with-claude/compaction)).
- **Compaction rules (on demand)** — put the block first in `messages`. Keep it "exactly as the API returned it, including its `signature`." "Remove exactly the summarized messages": any left in front of the block return a 400 error (`compaction_block_misplaced`). Send exactly one block on every later request. Two mistakes pass silently: leaving the block out (no summary reaches the model), and leaving summarized messages after it (they are sent again) ([source](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)).
- **Compaction limits** — a request cannot carry both `compaction` and `context_management`. A compaction request is rejected if the last assistant turn ends in a tool call with no result. Images, documents and fetched URLs inside the summarized turns are gone afterward. `cache_control` on the block places a cache breakpoint after the summary. The summary call is billed like any request; sending the block back adds no compaction cost.
- **Memory tool** — client-side: the model asks for file operations under `/memories`, your code runs them, and your code must reject any path outside that folder ([source](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).
- **Prompt caching** — enabled with `cache_control`. Cache writes cost 1.25 times base input for a 5-minute lifetime and 2 times for 1 hour; cache reads cost 0.1 times base input on most models, less on some newer ones. "There's no way to manually clear the cache. Cached prefixes automatically expire after a minimum of 5 minutes of inactivity." Track `cache_creation_input_tokens` and `cache_read_input_tokens` ([source](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).

### OpenAI (Responses API and Agents SDK)

- **State options** — resend the history yourself, chain with `previous_response_id`, use the Conversations API, or rely on stored responses (`store`, kept 30 days by default). Chaining does not save input cost: "Even when using `previous_response_id`, all previous input tokens for responses in the chain are billed as input tokens in the API" ([source](https://developers.openai.com/api/docs/guides/conversation-state)). The Agents SDK docs advise: "pick one strategy per conversation."
- **Compaction** — server-side compaction is set with `context_management` and `compact_threshold`. The response carries an encrypted compaction item that "is opaque and not intended to be human-interpretable." Replay the returned output items in order. When you chain by input arrays you may drop items before the most recent compaction item; with `previous_response_id`, "do not manually prune." A standalone `/responses/compact` endpoint "is fully stateless and ZDR-friendly", and its output must not be pruned ([source](https://developers.openai.com/api/docs/guides/compaction)).
- **Prefix edits** — the latest-model guide says that editing earlier history, some model changes, or end-user or organization changes make the API drop reasoning items, which can lower quality and break prompt caching. It advises putting reusable instructions in a first `developer` message rather than in top-level `instructions` ([source](https://developers.openai.com/api/docs/guides/latest-model)).
- **Managed harness** — the Agents API, where OpenAI runs the loop, includes automatic context compaction ([source](https://openai.com/index/introducing-the-agents-api)).

### DeepSeek

- **Caching** — automatic, with no code change. A hit needs a full match of a stored prefix unit. It is "best-effort" and "does not guarantee a 100% cache hit rate", and the cache is cleared after hours to days. Track `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. Pass `user_id` to isolate the cache between your end users ([source](https://api-docs.deepseek.com/guides/kv_cache)). Its Anthropic-compatible endpoint ignores `cache_control`.
- **Trimming** — the sources read for this skill found no server-side compaction or context editing; use the do-it-yourself steps above.

### Google (Agent Development Kit)

- **Concepts** — a `Session` is the current thread of events, `State` is data inside one session, and `Memory` is "Searchable, Cross-Session Information" managed by a `MemoryService` ([source](https://adk.dev/sessions/)). The hosted Memory Bank extracts memories from session events asynchronously. Tenant and user scoping of what it stores is yours to set and test.
