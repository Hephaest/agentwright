# Durable Steps for an Agent Run

Durable means a step's result is written to storage before the next step starts, so it survives a crash. A durable run, restarted after a crash, runs its function again from the top: each step that already finished returns its saved result at once, and only the unfinished work runs. A durable execution engine is a ready-made product that does the saving and the resuming for you.

- [What you already have](#what-you-already-have)
- [The hand-written step helper](#the-hand-written-step-helper)
- [Its limits](#its-limits)
- [When an engine is worth it](#when-an-engine-is-worth-it)
- [Vendor notes, as of November 2026](#vendor-notes-as-of-november-2026)

## What you already have

The worker in SKILL.md is already coarsely durable: the queue retries a job, and the turn plus the pending reply are saved in one transaction before anything is sent. That is one save point per run. A crash before it reruns every model call and every tool call of the run. For a run of a few minutes that is cheap to repeat, that is enough.

Anthropic, on its multi-agent research system: "Agents are stateful and errors compound ... When errors occur, we can't just restart from the beginning ... we built systems that can resume from where the agent was" ([source](https://www.anthropic.com/engineering/multi-agent-research-system)).

## The hand-written step helper

Neutral sketch, not run. One table, keyed by run and step name:

```sql
CREATE TABLE steps (
  run_id  text NOT NULL,                       -- the run's event id
  name    text NOT NULL,                       -- such as model-3 or tool-3-0
  result  jsonb NOT NULL,
  PRIMARY KEY (run_id, name)
);
```

```ts
async function step<T>(runId: string, name: string, fn: () => Promise<T>): Promise<T> {
  const saved = await steps.get(runId, name);
  if (saved) return saved.result as T;                 // finished before: reuse, never call again
  const result = await fn();                           // the gap: a crash after this line and before the next runs fn again
  await steps.insertIfAbsent(runId, name, result);     // ON CONFLICT DO NOTHING: an earlier writer's row is kept
  return (await steps.get(runId, name))!.result as T;  // continue with the stored result, whoever wrote it
}
```

In the loop, every model call and every tool call goes through `step`:

```ts
for (let turn = 0; turn < MAX_TURNS; turn++) {
  const response = await step(runId, `model-${turn}`, () => model.call(buildRequest(history)));
  history.push(response.message);
  if (response.toolCalls.length === 0) break;
  for (const [i, call] of response.toolCalls.entries()) {
    const name = `tool-${turn}-${i}`;
    history.push(await step(runId, name, () =>
      runTool(call, { tenantId, idempotencyKey: `${runId}:${name}` })));  // tenant from the run row, never the model
  }
  await renewLease();                                  // fenced; throws when the lease is lost
}
```

Rules that make replay correct:

- **One call, one step.** Never wrap the whole loop in one step: a crash then reruns all of it.
- **Names come from position, not content.** `model-<turn>` and `tool-<turn>-<index>` are stable because replay returns the same model responses, so the same calls arrive in the same order.
- **Tool errors are saved as results.** Return a failed tool as an error result (agent-build-loop), so a replay sees the same error. Only infrastructure failures throw, and those leave the step unsaved so it runs again.
- **Nothing outside a step may vary.** Reading the clock, a random value or a remote config value outside a step makes a replay take a different path. Put such reads inside a step.
- **Do not change step order under running runs.** A deploy that adds or moves a step shifts every later name, and a replay reuses the wrong result. Let in-flight runs finish first, or put a code version in the step name.
- **Clean up.** Delete a run's steps once it is done and past your retention, or the table grows with every model response.

### The gap, stated plainly

A crash after `fn` returns and before the save runs the step twice. The same happens when two workers run the same run at once after a lost lease: both call `fn`, and the read-back only makes them agree on one result afterwards. A step helper therefore guarantees at-least-once, never exactly-once. Every tool that writes must be idempotent: it sends `<run id>:<step name>` as its idempotency key, or it checks the target for an earlier write before writing. The extra model call costs money but changes nothing outside.

## Its limits

| The helper cannot | Do this instead |
|---|---|
| Wait hours or days inside a run | End the run. Save a pending action (agent-build-approval) or a follow-up row; the answer or the scheduler starts a new run. Never hold a lease across the wait. |
| Sleep until a time | Save a follow-up row; the scheduler enqueues it when due. |
| Coordinate fan-out across workers | Use an engine, or keep one worker per run. |
| Show a run's steps in a UI | Read the steps table, or use your traces (agent-harden-evals). |
| Close the at-least-once gap | Nothing closes it. Idempotent tools make it harmless. |

## When an engine is worth it

Recommended defaults:

| Situation | Default |
|---|---|
| A run of a few minutes, cheap to repeat, one reply at the end | The queue retry and the saved pending reply. No step table. |
| Many costly model or tool steps, where a rerun is expensive | The hand-written step helper. |
| A run that must wait hours or days for a person or a timer, fans out to sub-tasks, or there are many kinds of long run | An engine. |
| Your platform already offers a workflow product | Its engine, before writing your own. |

An engine does not remove the need for idempotent tools. Inngest lists "Idempotent steps (safe to retry)" as its first best practice ([source](https://www.inngest.com/blog/building-durable-agents)).

## Vendor notes, as of November 2026

Product names and APIs change. Check each vendor's current documentation with your documentation lookup tool before relying on any of this. Each line paraphrases or quotes the vendor's own page, so read it as the vendor's claim.

| Engine | What it is | How a step is marked | What it says about agents |
|---|---|---|---|
| Temporal | A workflow engine: workflow code replays from recorded history | Model and tool calls run as recorded activities | A workflow "resumes automatically after a crash, a network timeout, or a multi-day wait for a human to approve a step" ([docs](https://docs.temporal.io/ai)). Workflow code must be deterministic. |
| Inngest | Runs your functions when an event arrives | Wrap each call in `step.run`; a `singleton` setting allows one run per key | "An LLM call is a step. A tool execution is a step" ([blog](https://www.inngest.com/blog/ai-agents-inngest-durable-steps)) |
| Restate | A server in front of your functions that keeps the journal | It records each call made through it | A run that waits for a person is suspended until the answer arrives; "LLM calls are not repeated (saving cost and time)" ([tour](https://docs.restate.dev/tour/ai-agents), [blog](https://www.restate.dev/blog/resilient-serverless-agents)) |
| Trigger.dev | Hosted background tasks | Tasks checkpoint during waits; waitpoint tokens for approvals | "Tasks checkpoint during waits, so an approval step that waits a week uses no resources and isn't billed" ([page](https://trigger.dev/human-in-the-loop-ai-agents)) |
| Vercel Workflow | Workflow directives in your code | `'use workflow'` and `'use step'` | An agent helper runs the loop where "model calls run as durable steps and tools marked 'use step' get retries" ([docs](https://ai-sdk.dev/docs/agents/workflow-agent)) |
| Cloudflare Workflows | Durable steps on Cloudflare | `step.do`, `step.sleep`, `step.waitForEvent` | "`waitForEvent()` pauses for hours or days" ([docs](https://developers.cloudflare.com/workflows/get-started/durable-agents)) |

Agent frameworks with checkpointers, such as LangGraph's per-thread checkpointer, save state between graph steps; check whether the default saver is in memory before relying on it across restarts.
