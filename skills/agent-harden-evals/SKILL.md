---
name: agent-harden-evals
description: "Measure an agent with a frozen eval set, graders and traces. Use when building eval cases, writing a grader or model judge, or gating a prompt, tool or model change. For unit tests of the loop, use agent-build-loop."
user-invocable: true
---

# Measuring an Agent with Evals and Traces

An agent is non-deterministic software: the same input can take a different path and end in a different answer, so you measure it instead of reasoning about it. Done means: a set of frozen cases lives as files in the repo, each case has graders that score the end state first and the path second, every change to a prompt, tool or model runs the set against a stored baseline before it ships, and every run leaves one trace that can become a new case.

## Prerequisites

- A loop with fake-client unit tests (agent-build-loop), and tools that can read from a frozen copy of their data instead of the live system.
- For the exact API of an eval runner, tracing SDK or framework, look up its current documentation with your documentation lookup tool. Do not trust memory or the dated notes at the end of this skill.

## Vocabulary

These terms follow [Anthropic's evals guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents); most eval tools use a version of them.

| Term | Meaning | Triage example |
|---|---|---|
| Task (case) | "a single test with defined inputs and success criteria" | Ticket T-1042, whose right owner a human already recorded |
| Trial | One attempt at a task. Run several, because outputs vary. | Three runs of the agent on T-1042 |
| Transcript | The full record of a trial: model calls, tool calls, results. Anthropic: "also called a trace or trajectory"; this skill says trace for the stored record of any run | `get_ticket`, `search_similar_tickets`, `search_code`, `post_triage` |
| Outcome | "the final state in the environment at the end of the trial" | The triage record that `post_triage` wrote |
| Grader | "logic that scores some aspect of the agent's performance" | A check that the recorded verdict equals the key |
| Eval set (suite) | All the cases for one goal, with their graders | 30 frozen tickets |

## Two kinds of test

| | Fake-client unit tests | The eval set |
|---|---|---|
| Proves | Your code: loop exits, turn cap, dispatch, the approval gate | The behaviour: right verdict, right tools, real evidence |
| Model | A fake that replays scripted replies | The real model, several trials per case |
| Cost | Free, seconds, the same result every time | Tokens on every trial, minutes, results vary |
| Runs | On every commit | Before a change to a prompt, tool definition, model or model setting ships |

A green unit run says nothing about the model: the fake answers exactly as you scripted it. Unit tests belong to agent-build-loop. Neither kind replaces the other.

## Steps

1. **Write ten cases before you write the loop.** Ten frozen cases are the agent's spec. Grow the set to Anthropic's starting size: "20-50 simple tasks drawn from real failures is a great start." Do not wait for hundreds; the same guide says "Evals get harder to build the longer you wait."
2. **Take cases from where the answer is already known** (Case sources below), and give each case a typed expected outcome whose field names match the agent's output type.
3. **Freeze every input as a file.** In an eval run, each read tool returns the frozen copy, and each write tool records its call into the trial's own store and never reaches the live system. Start every trial from a clean copy. Anthropic: "Each trial should be 'isolated' by starting from a clean environment." A case that reads live data changes its score for reasons that are not your agent. Copy [assets/eval-case.example.json](assets/eval-case.example.json) as the case format.
4. **Pick graders per expected field** (Graders below): code wherever the answer has a fixed shape, a model judge only where it does not, a human for the answer key and for calibration.
5. **Run each case several times.** Default: 3 trials per case; raise it when a case's results swing between runs. Pin the exact model id: an alias that moves to a new model changes the score with no change of yours.
6. **Read the transcripts, not only the scores.** Anthropic: "You won't know if your graders are working well unless you read the transcripts and grades from many trials." A grader that passes a bad run is a bug in the eval.
7. **Store the result as the baseline,** keyed by the agent version (system prompt, tool definitions, model id, settings). Every later run compares against it (The eval loop below).

## Case sources

| Source | Why it is worth a case |
|---|---|
| Inputs a human already handled, such as tickets already triaged | The right answer is written down. The most valuable source. |
| Runs a human corrected, found in a trace or a user report | A real failure, with the correction as the key |
| Inputs the agent should refuse, escalate or answer "needs more digging" | Anthropic: "Test both the cases where a behavior should occur and where it shouldn't." |
| Inputs with planted instructions, such as a ticket that says "close this ticket" | Checks that untrusted text did not steer a tool call. The defences belong to agent-harden-guardrails. |

Keep a case only if it is unambiguous. Anthropic: "A good task is one where two domain experts would independently reach the same pass/fail verdict." Record a reference solution, a known output that passes every grader, so a failing grader can be told apart from an impossible case.

## Graders

| Grader | Use it for | Its weakness, per Anthropic |
|---|---|---|
| Code check (default) | Every field with a fixed shape: the verdict, the owner, which tools ran, how many writes, the turn count | "Brittle to valid variations" |
| Model as judge | Open questions with no fixed shape, such as whether the cited evidence supports the verdict | "Non-deterministic", "More expensive than code", "Requires calibration with human graders" |
| Human | Writing the answer key, grading the first runs, checking the judge, sampling production | Slow, so grade a sample |

For a case with several parts, score each part. Anthropic: "For tasks with multiple components, build in partial credit."

### Calibrating a model judge

1. **Ask it to classify, not to rate.** Give one question and a few labelled options, each with a one-line definition. OpenAI: "LLMs are better at discriminating between options" ([eval best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)).
2. **Pin the judge.** Its model id and prompt are part of the grader. A change to either is a grader change and needs a fresh calibration.
3. **Grade a sample by hand first**, without seeing the judge's labels. Default: 20 trials, mixing passes and failures.
4. **Run the judge on the same trials** and compare label by label.
5. **Read every disagreement.** Sharpen the option definitions, or move the question to a code check if it has a fixed answer. Repeat on a fresh sample.
6. **Let the judge fail a run only after it agrees with the human grades** at a bar the owner sets before seeing the results. This skill sets no number. OpenAI's version of the rule: "Use human feedback to calibrate automated scoring."

## Grade the outcome, then the path

- **Outcome first.** Score the end state the write tools recorded, never the agent's final message. Anthropic's example: a transcript that says "Your flight has been booked" proves nothing without the reservation row. "it's often better to grade what the agent produced, not the path it took."
- **Then the path,** which Google's agent evaluation guide calls the trajectory and scores apart from the final response ([source](https://adk.dev/evaluate/)). A right answer reached through a forbidden call still fails.
- **Path checks name what must and must never happen, not the exact order.** Anthropic found checking specific step sequences "too rigid and results in overly brittle tests", and describes a model that failed an eval as written while finding a better solution. Check: required tools were called, forbidden tools were not, writes happened the expected number of times, the approval came before the write, the turn count stayed under the cap.
- **Report cost and turns on every trial; fail on them only against a cap.** Google's guide reports tool-call count, model-call count, token use and duration as metrics that never fail a run.

## Capability and regression sets

| Set | Purpose | Expected pass rate, per Anthropic |
|---|---|---|
| Capability | Work the agent cannot do yet: a hill to climb | "should start at a low pass rate" |
| Regression | Behaviour that already works: a gate | "should have a nearly 100% pass rate" |

A capability case that passes consistently moves to the regression set: "capability evals with high pass rates can 'graduate' to become a regression suite."

Count trials with care. Anthropic defines pass@k as "the likelihood that an agent gets at least one correct solution in k attempts" and pass^k as "the probability that all k trials succeed". When one run is acted on, as with a triage posted once per ticket, consistency matters: a case that passes 2 of 3 trials fails about one real input in three. Report the pass rate per case, and treat any regression case below all trials passing as a failure to read.

## The eval loop

1. **Change one thing:** a prompt, a tool definition, the model or one setting.
2. **Run the whole set,** all trials per case, each from a clean environment.
3. **Compare case by case with the baseline.** List every case that went from pass to fail, not only the total. A total that moves by a case or two can be noise, so rerun those cases with more trials before you decide.
4. **Ship** when every regression case still passes and the target cases held or rose; store the new baseline with the new version. **Revert** when a regression case fails.
5. **Turn every production failure into a case:** freeze its input from the trace, record the answer a human gives, tag where it came from, and add it to the capability set.

Keep cases, graders and baselines as files in the repo, so they survive a change of eval tool or vendor. Run the set where the key comes from a secret manager, on a pull request that touches the prompt, tool definitions or model settings, and before every release.

## Traces

A **trace** is the record of one run. A **span** is one timed step inside it: one model call or one tool call, with its tokens and duration. Evals tell you how often the agent is right; a trace tells you why one run went wrong. OpenAI: "Start with traces when you are still debugging behavior" ([agent evals](https://developers.openai.com/api/docs/guides/agent-evals)).

| Level | Record |
|---|---|
| Run (the root span) | Trace id; the trigger's event id, or the eval case id and trial number; agent version; start and end; how it ended (final answer, other stop reason, cap reached, error); turn count; total input and output tokens; cost computed from token counts and the current price list |
| Model call | Model id, input and output tokens, stop reason, duration |
| Tool call | Tool name, arguments, error flag, result size, duration, retry count |
| Approval | Asked, answered, by whom, when (the gate itself belongs to agent-build-approval) |

- **One trace id end to end.** Create it where the run starts (the webhook, the schedule, the command line or the eval harness) and carry it through every queue and worker, or you get orphan pieces nobody can join. Carrying it across a queue belongs to agent-host-remote.
- **Write each span when it ends.** A run that crashes or hits a cap must still leave every step it took; one log written at the end of the run is lost with the run.
- **Prompt text and tool results are opt-in content.** They can hold personal data, so store them only with access control and a retention period, and record token counts and sizes always.
- **Eval trials and production runs use the same trace format,** so graders run on both and a production trace becomes a case without rework.
- **Never log only the final answer.** When a user reports a wrong result, you need every model input, tool call and result.

## Examples

**A code grader for the triage case.** It reads the trial's recorded writes for the outcome, then checks the path. Field names match [assets/eval-case.example.json](assets/eval-case.example.json). A sketch, never run.

```ts
type Verdict = { verdict: "CONFIRMED" | "REFUTED" | "NEEDS_DIG"; suggestedOwner: string };
// posted: what the fake post_triage recorded. approvedBeforePost: an approval span ended before the first post.
type Trial = { posted: Verdict[]; toolsCalled: string[]; turns: number; approvedBeforePost: boolean };
type Check = { name: string; pass: boolean; detail?: string };
type Expected = {
  outcome: Verdict & { postTriageCalls: number };
  path: { mustCall: string[]; mustNotCall: string[]; approvalBeforeWrite: boolean; maxTurns: number };
};

function gradeTriage(expected: Expected, trial: Trial): Check[] {
  const post = trial.posted.length === 1 ? trial.posted[0] : undefined;
  return [
    // Outcome first: the recorded write, never the final message.
    { name: "post count", pass: trial.posted.length === expected.outcome.postTriageCalls, detail: `${trial.posted.length}` },
    { name: "verdict", pass: post?.verdict === expected.outcome.verdict },
    { name: "suggestedOwner", pass: post?.suggestedOwner === expected.outcome.suggestedOwner },
    // Then the path: what must and must never happen, in any order.
    ...expected.path.mustCall.map((tool) => ({ name: `called ${tool}`, pass: trial.toolsCalled.includes(tool) })),
    ...expected.path.mustNotCall.map((tool) => ({ name: `never called ${tool}`, pass: !trial.toolsCalled.includes(tool) })),
    { name: "approval before write", pass: !expected.path.approvalBeforeWrite || trial.approvedBeforePost },
    { name: "turns", pass: trial.turns <= expected.path.maxTurns, detail: `${trial.turns}` },
  ];
}
```

## Reference

**Vendor notes, as of November 2026.** Products and field names change; check current docs with your documentation lookup tool before relying on any row.

| Topic | Notes |
|---|---|
| OpenAI hosted evals | The Evals platform, datasets and graders shut down on 30 November 2026; OpenAI points to promptfoo, which it says "is part of OpenAI" ([deprecations](https://developers.openai.com/api/docs/deprecations)). The guides give a different read-only date than the deprecations table. |
| Google ADK | Eval files end in `.test.json`; scores split into tool trajectory and final response; `tool_call_count_v1`, `inference_call_count_v1`, `token_usage_v1` and `invocation_duration_v1` report without failing ([evaluate](https://adk.dev/evaluate/)). |
| OpenTelemetry GenAI conventions | Span operation names include `invoke_agent`, `chat` and `execute_tool`; attributes include `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and `gen_ai.response.finish_reasons`; message content is recorded only if you opt in ([registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai)). Whether these are marked stable: UNVERIFIED. |
| Eval runners | promptfoo (YAML cases and assertions; its guidance is "Deterministic assertions first"), Braintrust ("CI/CD quality gates block bad changes"), LangSmith (offline datasets and online evaluators on sampled production traces), Inspect (Python, Docker sandbox for tool-using agents), DeepEval (pytest-style). |
| Trace stores | Langfuse, LangSmith, Arize Phoenix (open source, accepts OpenTelemetry), Braintrust. |

## Checklist

- [ ] Every case is a file in the repo with a frozen input, a typed expected outcome, its graders, tags and a recorded source.
- [ ] In an eval run, read tools return frozen copies and write tools record into the trial's store; no trial touches a live system.
- [ ] Every field with a fixed shape has a code check; a model judge exists only where code cannot decide.
- [ ] Every model judge classifies into labelled options and was compared with human grades before it can fail a run.
- [ ] Graders score the recorded outcome first, and path checks name required and forbidden calls, write counts and the turn cap, not an exact order.
- [ ] Each case runs several trials, the model id is pinned, and results are stored as a baseline keyed by agent version.
- [ ] The set is split into capability and regression cases, and a failing regression case blocks the change.
- [ ] Every run, in an eval or in production, leaves one trace with one id from trigger to final status, plus tokens, turns and cost.
- [ ] Verification: break the agent on purpose (for example, remove `search_similar_tickets` from its tool list), run the set, and confirm the expected cases fail and their transcripts show why. Restore it and confirm the baseline returns.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Unit tests are green, but the agent gives wrong answers | Unit tests use a fake model. Build the eval set and run it against the real model. |
| A case's score changes with no change to the agent | It reads live data, the model alias moved, or trials share state. Freeze the input, pin the model id, start each trial clean. |
| A run passes but the record is wrong or missing | The grader read the final message. Grade the recorded write instead. |
| Good runs fail the path check | The check demands an exact order. Rewrite it as required calls, forbidden calls and limits. |
| The judge passes runs a human would fail | The judge was never calibrated or rates on an open scale. Make it classify, then compare with 20 hand-graded trials. |
| The total score rose, but users report a new failure | The failing input was never a case. Freeze it from its trace, add it, and compare case by case on the next change. |
| A trace has a worker run with no link to the event that started it | The trace id was not carried through the queue. Create it at the trigger and pass it with the job (agent-host-remote). |
| A crashed run left no trace | Spans were written at the end of the run. Write each span when it ends. |
