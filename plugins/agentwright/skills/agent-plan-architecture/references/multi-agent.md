# Multi-agent designs

Read this after step 5 of SKILL.md says you have a named reason for more than one agent. It covers the shapes, how a handoff works in code, what extra agents cost, and the guardrail gap they open.

- [Terms](#terms)
- [A subagent is a tool](#a-subagent-is-a-tool)
- [Three shapes](#three-shapes)
- [Handoff mechanics](#handoff-mechanics)
- [What extra agents cost](#what-extra-agents-cost)
- [When several agents hurt](#when-several-agents-hurt)
- [The guardrail gap in agent chains](#the-guardrail-gap-in-agent-chains)

## Terms

- **Subagent** — an agent that another agent calls the way it calls a tool. It runs its own loop in its own context window and hands back one answer.
- **Multi-agent** — any system where more than one such loop works on one task.
- **Manager** — an agent that calls specialist agents as tools, gets their results back, and keeps talking to the user itself.
- **Handoff** — the agent in charge gives the whole conversation to another agent, which answers the user directly. OpenAI's guide calls it "a one way transfer".

## A subagent is a tool

The whole mechanism is one boundary between two context windows. The parent sends a task; the subagent may read forty files; only its final message lands in the parent, as one tool result. Anthropic's agent SDK docs state the rule: "only its final message returns to the parent" ([subagents](https://platform.claude.com/docs/en/agent-sdk/subagents)).

Design rules (recommended defaults):

- **Task in** — the subagent cannot see the parent's history, so the task text carries everything it needs: the goal, the inputs, and what a finished answer looks like.
- **Summary out** — it returns a short summary with stable references, such as file paths or record ids, never the raw material it read.
- **Narrow tools** — give it only the tools its task needs. A reviewer subagent gets read tools and no write tools.
- **Own cap** — it gets its own turn cap and budget, because its loop is a full loop.
- **One owner of writes** — writes stay with the agent that a human can hold to account; a research subagent should not post.

## Three shapes

Routing is a workflow pattern (SKILL.md step 2). Manager and handoff are the two multi-agent shapes in OpenAI's guide ([A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)). The "use it when" row is a design judgment, not a vendor statement.

| Question | Routing | Manager | Handoff |
| --- | --- | --- | --- |
| Who decides the route? | Your code, with a switch | The manager agent, per subtask | The agent in charge, mid-conversation |
| Who talks to the user next? | The branch you chose | The manager, always | The agent that received the conversation |
| What does the other side see? | The input | Only its own task | The whole conversation so far |
| What comes back? | Nothing; the branch finishes | A result, like a tool result | Nothing; control does not return |
| Use it when | One input you can label up front, such as a ticket | Parallel or isolated subtasks, one voice to the user | A live conversation whose right specialist appears only after a few messages |

For a single ticket or email, routing does the same job as a handoff and is cheaper and more predictable. If the specialist returns its result to the first agent and the first agent replies, it is the manager shape, not a handoff.

## Handoff mechanics

A handoff is a tool call. Each allowed target becomes a tool named `transfer_to_<name>`. When the model calls one, the current agent's run ends and the caller starts the target as a new, separate run. The first agent is not called again for that message. An agent is only a record: name, system prompt, tools, and the agents it may hand off to.

The sketch below uses a small neutral interface; it is not any vendor's SDK, and it has not been run. The loop details it relies on (exits, caps, errors as results) are agent-build-loop.

```ts
interface ToolCall { id: string; name: string; input: unknown }
interface ModelReply {
  stopReason: "tool_call" | "end" | "max_tokens" | "refusal";
  message: Message; // the whole assistant message, sent back unchanged
  toolCalls: ToolCall[];
}
interface Agent { name: string; system: string; tools: ToolDefinition[]; handoffs: string[] }
type RunEnd = { kind: "finished"; reply: ModelReply } | { kind: "handoff"; to: string };

const transferName = (target: string) => `transfer_to_${target}`;

async function runAgent(agent: Agent, messages: Message[], maxTurns: number): Promise<RunEnd> {
  const tools = [...agent.tools, ...agent.handoffs.map(transferTool)];
  for (let turn = 0; turn < maxTurns; turn++) {
    const reply = await model.call({ system: agent.system, tools, messages });
    messages.push(reply.message);
    if (reply.stopReason !== "tool_call") return { kind: "finished", reply };

    // Only targets on this agent's list count; any other name is an unknown tool.
    const target = agent.handoffs.find((name) => reply.toolCalls.some((call) => call.name === transferName(name)));
    for (const call of reply.toolCalls) {
      // Every tool call gets a tool result. During a transfer, other calls are answered, not run.
      messages.push(
        target === undefined ? await runTool(agent, call)
        : call.name === transferName(target) ? toolResult(call, "Transferred.")
        : toolResult(call, "Not run: the conversation was transferred.", { isError: true }),
      );
    }
    if (target !== undefined) return { kind: "handoff", to: target };
  }
  throw new Error(`${agent.name}: out of turns`);
}

async function handleMessage(session: Session, agents: Record<string, Agent>, limits: Limits) {
  let agent = agents[session.activeAgent];
  for (let hop = 0; hop <= limits.maxHandoffs; hop++) {
    const end = await runAgent(agent, session.messages, limits.maxTurns);
    if (end.kind === "finished") {
      // One write: the messages and the active agent together, so a crash cannot split them.
      await saveSession({ ...session, activeAgent: agent.name });
      return end.reply;
    }
    agent = agents[end.to];
  }
  throw new Error("Too many handoffs");
}
```

Decisions this sketch makes, and why:

- **Calls beside a transfer are not run** — a write requested in the same reply as a transfer would run under an agent that is giving up the conversation. Answering it with an error result keeps every tool call paired with a result.
- **A handoff cap** — two agents can hand a conversation back and forth forever. `limits.maxHandoffs` and `limits.maxTurns` are constants the owner sets; there is no vendor-given value.
- **The active agent is saved with the messages** — the user's next message must go to the agent that now owns the conversation. Saving the two in separate writes lets a crash between them resume the wrong agent.
- **Out of scope here** — one run per conversation at a time, and posting the reply exactly once, are agent-host-remote.

What the next agent receives is the one design choice. Passing the same messages keeps everything; OpenAI's guide describes the new agent taking over with the conversation state. Passing a short summary gives a cheaper, cleaner context at the risk of leaving something out. Test on your provider that a history containing a `transfer_to_<name>` call is accepted by a request whose tool list no longer has that tool; if it is not, pass a summary.

## What extra agents cost

Figures from Anthropic's [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) write-up. They are Anthropic's own measurements on its own evals.

| Claim | Exact wording or figure |
| --- | --- |
| Token use | "agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats" |
| Quality gain | A lead agent on a larger model with subagents on a smaller model "outperformed single-agent Claude Opus 4 by 90.2% on our internal research eval" |
| Why it helped | On the BrowseComp eval, "token usage by itself explains 80% of the variance" |

Read the last two together: much of what a multi-agent design buys is a way to spend more tokens usefully. The 15 times figure is against a chat, so a fan-out costs roughly four times a single agent on the same task (arithmetic from the two figures, not a measurement).

A strong model for the lead and a cheaper model for workers is the shape Anthropic's system used. Switching models in the middle of one history breaks the provider's prompt cache, so switch at a subagent boundary, where the context starts fresh (this follows from how prefix caches match; UNVERIFIED as measured).

## When several agents hurt

- **Coordination** — Anthropic: "LLM agents are not yet great at coordinating and delegating to other agents in real time", and domains "that require all agents to share the same context or involve many dependencies between agents are not a good fit".
- **Shared decisions** — Cognition's two principles: "Share context", and "Actions carry implicit decisions, and conflicting decisions carry bad results". Parallel workers that cannot see each other produce inconsistent work ([Don't build multi-agents](https://cognition.ai/blog/dont-build-multi-agents)).
- **Debugging** — OpenAI: "Splitting too early creates more prompts, more traces, and more approval surfaces without necessarily making the workflow better" ([Agents SDK orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)).
- **OpenAI's split signals** — split only for prompts with too much conditional logic, or for tool overload, where "The issue isn't solely the number of tools, but their similarity or overlap".

## The guardrail gap in agent chains

OpenAI's Agents SDK docs: "Input guardrails run only for the first agent in the chain. Output guardrails run only for the agent that produces the final output. Tool guardrails run on the function tools they're attached to" ([guardrails and approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)).

The general lesson holds in any framework: a check on the user's first message does not protect an agent reached later by handoff. Hostile text usually arrives through tool results, such as a ticket body, after the input check has run. Put the check next to the tool that has the side effect: the write tool validates its own input, and code gates the real write behind approval. Approval design is agent-build-approval; the guardrail layers and prompt injection are agent-harden-guardrails.
