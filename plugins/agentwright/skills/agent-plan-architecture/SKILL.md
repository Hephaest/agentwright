---
name: agent-plan-architecture
description: "Decide an AI agent's architecture before writing code: single call, workflow or agent; where the loop comes from; local or remote; one agent or several. Use when planning or reviewing an agent design or choosing a framework."
user-invocable: true
---

# Agent Architecture Decisions

Walk six decisions in order, take each default, and move off it only when the stated condition is true for your task. The rule under all six: pick the plainest design that passes your real examples, and add machinery only for a need you can name. Success is a choice at each step, with its reason, that someone can review before any code exists.

## Prerequisites

- About ten real inputs for the job, each with the answer a careful human would give. Building them into an eval set is agent-harden-evals.
- For the exact API of any SDK, framework or hosted runtime, look up its current documentation with your documentation lookup tool. Do not trust memory or the dated notes in [references/landscape.md](references/landscape.md).

## 1. Describe the agent

An agent is a model using tools in a loop: the model asks for a tool call, your code runs it, the tool result goes back, and the model decides the next step. Every agent has six parts. Fill one line for each.

| Part | What it is | Question it answers |
| --- | --- | --- |
| Trigger | What starts a run: a person, a schedule, an event from another system | What starts it? |
| Model | Reads everything so far and decides: answer, or request a tool call | Which model? Decided last, by testing (step 3) |
| Tools | Functions in your code that the model may ask to run, with whose credentials | What can it touch? |
| Channel | Where the answer goes: a chat thread, a ticket comment, a pull request | Where does the answer land? |
| State | Instructions, session history and memory that outlive one model call | What does it remember? |
| Guardrails | Caps, approvals and rules around the loop | Who can stop it? |

Also write one line for "How will we know it works?" and one for the audience: one person, an internal team, or customers. The audience decides most of step 4. In practice, the model, tools and loop are the small part of the work; trigger, channel, state and guardrails are most of it.

## 2. Single call, workflow or agent

Apply one test (a reading of the vendor definitions, not a vendor statement): **who wrote the `if`, the `for` and the order of the calls?** If your code did, it is a workflow, even when a model makes a decision inside it. If the model picks the next step after seeing each result, including when to stop, it is an agent. Anthropic draws the same line: workflows are "orchestrated through predefined code paths"; agents "dynamically direct their own processes and tool usage" ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).

```ts
// Sketch, not run. ask() is one model call that returns its text.
// Workflow: your code fixed the order and the branch.
const summary = await ask(summarizePrompt(ticket));
const severity = await ask(severityPrompt(summary));
if (severity === "high") await pageOnCall(summary);

// Agent: after each tool result, the model picks the next step and when to stop.
for (let turn = 0; turn < maxTurns; turn++) {
  const reply = await model.call({ system, tools, messages });
  messages.push(reply.message);
  if (reply.stopReason !== "tool_call") return reply.text;
  messages.push(...(await runToolCalls(reply.toolCalls)));
}
```

Writing the loop itself is agent-build-loop. The rungs below run from plainest to most flexible. The five workflow patterns are Anthropic's; the "use it when" quotes are Anthropic's; the order as a ladder is a recommended default.

| Rung | Who decides the steps | What the model decides | Use it when |
| --- | --- | --- | --- |
| Single call | Nobody; one request | The whole answer | Retrieval plus a few solved examples in the prompt get it right: "usually enough" for many applications |
| Prompt chaining | Your code, fully | Only the content of each step | Fixed steps; "trade off latency for higher accuracy, by making each LLM call an easier task" |
| Routing | Your code, with a switch | Which label the input gets | "distinct categories that are better handled separately"; a branch may itself be a chain or an agent |
| Parallelization | Your code, from a fixed list | Only the content of each part | Independent subtasks you can list in advance, merged by plain code |
| Orchestrator-workers | Your code fixes the phases: plan once, fan out, combine | Which subtasks exist | Subtasks "aren't pre-defined, but determined by the orchestrator based on the specific input" |
| Evaluator-optimizer | Your code owns the loop and its exit | Whether a draft passes | "clear evaluation criteria", and another round gives "measurable value" |
| Agent | The model, on every turn | Which tool, how often, when to stop | The steps depend on what the model finds along the way |

Climb in this order:

1. Try one call with retrieval (relevant text, such as similar past tickets, looked up and added to the prompt) and a few solved examples on your ten inputs. Anthropic: "the simplest solution possible ... This might mean not building agentic systems at all."
2. If it fails, ask whether you can write the steps down in advance. If yes, build the lowest workflow pattern that passes.
3. Make only the open part an agent: the part whose steps depend on results. Keep fixed steps in code at both ends. A ticket-triage agent fetches the ticket and posts the verdict as fixed steps; only what to search, and how deep, is the agent's choice.
4. Climb a rung only when the rung below fails on real examples, never because the higher rung sounds more capable.

OpenAI's guide names three signals that an agent fits: nuanced judgment, rules too complex to maintain, and heavy unstructured data; "Otherwise, a deterministic solution may suffice" ([A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)). An agent costs four things a workflow does not (a design judgment, not a vendor statement): latency from turns that run one after another, tokens from resending the history every turn, a different path on a second run of the same input, and testing by graded outcomes instead of a fixed call sequence.

Google frames the split less sharply. Its whitepaper calls an agent "a complete application" ([Introduction to Agents](https://www.kaggle.com/whitepaper-introduction-to-agents)), and its agent kit puts code steps and model steps in one graph ([graph workflows](https://adk.dev/graphs/)). Google material may call a design an agent that this test calls a workflow with model steps. Apply the test to each step, not to the product name.

## 3. Where the loop comes from

A **harness** is the program around the model that runs the loop, owns the tools and enforces the rules. A coding agent you use daily is one, and many can run as a library or as a headless command (no chat screen: prompt in, answer out). Product names per option are in [references/landscape.md](references/landscape.md).

| Option | You write | You get | You give up | Default for |
| --- | --- | --- | --- | --- |
| Own loop on a model API | The loop, tools, retries, state, stop rules | Full control; every prompt visible | Plumbing such as approvals and streaming is yours | A narrow agent whose abilities are a few typed functions of your own |
| Coding-agent harness | Configuration, plus your own tools if needed | File and shell tools, permissions, compaction (old turns summarized), sessions | The harness's defaults and release pace | An agent whose work is files and commands |
| Agent SDK or framework | Configuration, your tools, your hosting | The loop plus plumbing: streaming, approvals, memory | A layer over your prompts; renames between versions | An app feature that needs one named piece of plumbing |
| Hosted runtime | Agent configuration and the events you send | Loop, tools and a sandbox (an isolated machine for the agent's commands) run by the vendor | Control over where the run and its data live | Long sandboxed runs, nobody to run servers, and the data terms fit |

Rules for this step (recommended defaults unless attributed to a vendor):

- **Default** — your own loop. It is a sound production choice for a narrow agent, not a learning exercise.
- **Framework rule** — add a framework only when you can name the feature you need from it, such as approvals that survive a restart. Anthropic: "start by using LLM APIs directly ... If you do use a framework, ensure you understand the underlying code." LangChain, which sells one, agrees you "may not need one" if you do not need its features ([How to think about agent frameworks](https://www.langchain.com/blog/how-to-think-about-agent-frameworks)).
- **Hosted runtime** — read the vendor's data-retention and compliance terms before choosing it; some hosted runtimes exclude zero-retention or health-data contracts (see landscape notes).
- **Own your assets** — keep tools, prompts and test cases in files you own, whatever runs the loop. The loop is cheap to rewrite; those are not.
- **Test the model in your harness** — the harness moves results, not only the model. Epoch AI found that switching only the scaffold (their word for the harness) made "up to an 11%" and "up to a 15% difference" for two models on one coding benchmark ([Why benchmarking is hard](https://epoch.ai/gradient-updates/why-benchmarking-is-hard)). Never compare a vendor's published score with your own; run your ten cases in your loop with each candidate model.
- **Compatible endpoints** — an "OpenAI-compatible" provider accepts the same request shape but silently ignores or rejects some fields. Rerun your cases on every provider before switching.

## 4. Local or remote

A local agent runs on one person's machine as that person, with their logins and files. A remote agent runs as a service with its own identity and serves many people. The loop, tools and prompt are the same in both; only the surroundings change. Start local, and go remote when any answer below is yes.

| Question | If yes |
| --- | --- |
| Do several people need it, not only its owner? | Remote |
| Must it run when no laptop is on? | Remote |
| Does it need its own audited identity, separate from any person? | Remote |

- **Audience shortcut** — personal use is local; a customer-facing agent is always remote; an internal-team agent is remote once anyone besides the owner relies on it.
- **Blast radius** — a local agent can reach everything its owner can reach. A remote agent can reach only what was granted, but for every user at once.
- **Migration** — the prompt, tools, loop and test cases move almost unchanged. The trigger, session storage, identity and approval channel are rewritten. Tools that quietly used the owner's login are the trap: on a server they fail, or someone hands them one all-powerful token.

Building each is agent-host-local and agent-host-remote.

## 5. One agent or several

A **subagent** is an agent another agent calls like a tool: it runs its own loop in a fresh context and returns only its final message. A **handoff** gives the whole conversation to another agent, which then answers the user itself. The default is one agent (OpenAI: "maximize a single agent's capabilities first").

| If you can name | Use |
| --- | --- |
| Context to isolate, such as many files read to answer one question | One subagent that returns a summary, not the files |
| Work that is truly parallel, with no shared state between pieces | Workers fanned out, then merged |
| A live conversation whose right specialist appears only after a few messages | A handoff to that specialist |
| One input you can label up front | Routing (a workflow, step 2), not several agents |
| None of these | One agent with better tools and a better prompt |

Budget for the cost: in Anthropic's write-up, agents used about 4 times the tokens of a chat and multi-agent systems about 15 times ([multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)). The same post says most coding tasks have "fewer truly parallelizable tasks than research". Shapes, handoff mechanics and the guardrail gap in agent chains are in [references/multi-agent.md](references/multi-agent.md).

## 6. Durable-execution engine or not

A durable-execution engine records each step's result before moving on, so a restarted process resumes from the last finished step instead of calling the model again. The default is no engine. Decide here; the mechanics are agent-host-remote.

| Situation | Use |
| --- | --- |
| A run takes seconds to a few minutes, and a restart from scratch is cheap | A queue with retries, plus idempotent writes (safe to run twice) |
| A run pauses for a human approval | A saved pending action that a later run resumes (agent-build-approval); no engine needed |
| A run is long and multi-step, and a crash would re-pay for finished model calls or repeat side effects you cannot make idempotent | A durable-execution engine, one recorded step per model call and per tool call |
| A local agent on one machine | No engine; a run lock and a rerun |

Anthropic's reason for resuming instead of restarting: "Agents are stateful and errors compound ... we built systems that can resume from where the agent was" ([multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).

## Checklist

- [ ] Every row of the step 1 table, the "how will we know it works" line and the audience line have a one-line answer.
- [ ] The control-flow test was applied to every step, and each step is labelled code or model.
- [ ] Every rung above a single call names the lower-rung failure that justified it.
- [ ] Any framework or hosted runtime names the feature it was chosen for; a hosted runtime names the data terms that were checked.
- [ ] Local or remote follows from the three questions, and remote tools have their own scoped identity.
- [ ] Any extra agent names the context it isolates, the parallel work it does, or the shift it hands off.
- [ ] Run the lower rung (one call with retrieval and examples, or the chosen workflow) on the ten example inputs and record its pass count before building anything higher.

## Troubleshooting

| Mistake | Fix |
| --- | --- |
| Calling a design an agent because a model makes a decision in it | Apply the control-flow test; a plan, label or pass mark from a model inside code-owned steps is a workflow |
| Building an agent or adopting a framework before one call with retrieval was tried | Run the single call on the ten inputs first; climb only on a recorded failure |
| Making the whole job an agent, including the fixed steps | Keep fetch-the-input and post-the-result in code; give the model only the open middle |
| Choosing a framework for the loop, or by popularity | Name the plumbing feature you need; if none, write the loop |
| Picking a model from a vendor's benchmark score | Run your own cases in your own harness with each candidate model |
| Swapping the base URL to a "compatible" provider without retesting | Rerun every case on the new provider; check the dropped-field list in references/landscape.md |
| Choosing a hosted runtime to save code without reading its data terms | Check retention, residency and compliance terms first; self-host the sandbox or pick another layer if they do not fit |
| Starting remote for a tool only its owner uses | Start local; go remote when one of the three questions turns yes |
| Moving a local agent to a server with tools that used the owner's login | Give the service its own identity with scoped tokens before the move |
| Splitting into several agents with no named reason | Return to one agent and improve its tools; split only on a row of the step 5 table |
| Adding a durable engine for runs of a few seconds, or for an approval wait | Use a queue with retries and idempotent writes; save approvals as pending actions |
