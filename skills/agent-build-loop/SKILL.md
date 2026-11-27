---
name: agent-build-loop
description: "Write and test an agent's tool-calling loop: exits, turn cap, tool errors as results, input validation. Use when writing the loop or debugging a failed request after a tool turn. For tool design, use agent-build-tools."
user-invocable: true
---

# Building the Agent Loop

The success state is a short loop that ends in exactly one of three ways: it returns the model's final answer, it throws because the model stopped for another reason, or it throws because it ran out of turns. Every tool call in between gets exactly one result, including calls that fail. A fake model client proves this logic in tests before the loop spends a token.

## Prerequisites

- The plan already says this job needs a loop you write yourself, not a fixed workflow, a coding-agent harness or a hosted runtime; if not, use agent-plan-architecture first.
- For the exact API of an SDK or framework, look up its current documentation with your documentation lookup tool. Do not trust memory or the dated notes at the end of this skill.
- The API key lives in a secret manager, a vault app that hands the key to one command's environment as it starts. The key is never in a file, the prompt, a log or shell history.

## Steps

1. **Make one model call with no tools.** Send the task, print the text. If that answers the job, stop: one call in and one answer out is a pipeline, and a pipeline is often the right design.
2. **Declare one tool.** A tool definition is plain data sent with every request: a name, a description, and a JSON Schema (a JSON description of the arguments' shape). The model never runs anything. It only replies with a tool call, and your code decides what runs. Description and naming rules belong to agent-build-tools.
3. **Write the adapter.** Copy [assets/loop-skeleton.ts](assets/loop-skeleton.ts). Implement its `ModelClient` for your SDK: build the first user message, make the call, map the vendor's stop reason to `final`, `toolCalls` or `stopped`, decode each tool call, and format results the vendor's way. The adapter is the only vendor-specific code.
4. **Write each tool with a run-time input check.** The model can send any shape. Parse the input like a request body from outside, and throw a message that says what valid input looks like. A type cast checks nothing.
5. **Keep the loop as the skeleton has it.** Change only the system prompt, the tool list and `maxTurns`. The rules below say why each line is there.
6. **Test with a fake client** (Examples). Cover every case in the Checklist.
7. **Run it once for real**, with the key injected by the secret manager (with 1Password, for example, `op run --env-file=.env.tpl -- <command>`, where the file holds only a reference such as `op://vault/item/field`). Read the history turn by turn: what the model asked for, what your code did, how the history grew.

## The wire shape, in neutral terms

| Piece | What it carries | Who makes it |
|---|---|---|
| Tool definition | Name, description, argument schema | Your code, sent with every request |
| Tool call | A call id, the tool name, the arguments (an object or a JSON string, by vendor) | The model, inside its reply |
| Tool result | The matching call id, the result text, an error flag | Your code, as the next history entry |
| Stop reason | Why the model stopped: answered, wants tools, or something else | The model, once per reply |

One reply is a list of pieces. It can hold text and several tool calls at once. The stop reason labels the whole reply; each piece has its own type. Text beside a tool call is normal, so the loop skips it when it runs tools, and loses nothing because the whole reply is already in the history.

## Exits

| The reply says | The loop does |
|---|---|
| Final answer | Return it. |
| Tool calls, with at least one call | Run every call, send all results back, call again. |
| Tool calls, but none in the reply | Throw: the reply is inconsistent. |
| Any other stop reason: reply cut off at the length limit, stop sequence, refusal, context window full | Throw with the stop reason. A cut-off or refused reply is not an answer, so the caller decides: retry with a larger reply limit, use another model, or report failure. |
| The turn cap is reached | Throw. Never return a partial or invented answer. |

When you enable tools that the vendor runs on its own servers, a vendor can add a "paused, send it back to continue" stop reason. Map it to another call that still counts against the cap, and check the vendor's stop-reason reference for the exact rule.

## Rules

- **Turn cap** — `maxTurns` counts model calls and has no default, so every caller chooses it. The examples here use 10 as a placeholder; set the real value from traces of real runs. Without a cap, a confused model can call tools forever, and every turn costs tokens and time; a model given an error result may simply retry the same call. Token budgets, repeat-call detection and kill switches belong to agent-harden-guardrails.
- **One result per call** — every tool call in a reply gets exactly one result, matched by its call id, even when the tool failed. Vendor docs require this, and a missing result can make the next request fail.
- **Errors are results** — catch every tool failure, unknown tool name and undecodable argument, and send it back as an error result. Write the error in the result text as well as setting the flag, because some compatible endpoints ignore the flag. Make the text actionable: "No ticket T-9999. Ids look like T-1042." Then the model can fix its input, try another tool, or say it is stuck. A thrown tool error kills the run; a skipped one breaks the history.
- **Validate at run time** — check every argument inside the tool before it runs, even when the SDK offers typed tools or a strict schema mode. Strict mode makes the shape match; it does not check business rules such as "this ticket exists".
- **Append the reply whole** — push the vendor's reply message into the history unchanged, before you act on it. Never rebuild it from role, text and tool calls. Reasoning models return hidden fields beside the text, and several vendors reject the next request, or plan worse, when those fields are missing.
- **Run calls in order** — by default, run the calls of one reply one at a time, in the order sent, so a later call sees the effect of an earlier one. Run them concurrently only when every tool in the reply is read-only.
- **History is the run's only memory** — the model keeps nothing between calls. Each call resends the whole history, so input grows every turn and a run's total input grows faster than its turn count. Keep tool results small; caching and long-history strategies belong to agent-build-context.
- **Writes wait for a gate** — the skeleton runs every tool the moment the model asks. Before you add a tool that changes anything, gate it with agent-build-approval.
- **A retried run repeats its tools** — the loop keeps state in memory, so a crash loses the run, and a caller that retries from the start runs every tool again. Keep tools read-only or safe to repeat until durable steps exist (agent-host-remote).

## If an SDK runs the loop for you

The rules still hold; you check them instead of writing them. Confirm where the SDK sets its turn cap and what it does when the cap is reached, how it reports a failed tool to the model, and that it keeps the reply whole. Validate input inside each tool function anyway: at least one vendor's loop helper documents that it does not validate input at run time.

## Examples

**A fake client and two tests.** The fake replays scripted replies and records the results the loop sends back, so the tests run with no network and no tokens.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, getTicketTool, AgentLoopError, type ModelClient, type ModelReply, type ToolResult } from "./loop-skeleton";

function fakeClient(replies: ModelReply[]) {
  const sent: ToolResult[][] = [];
  const client: ModelClient = {
    userMessage: (text) => ({ role: "user", text }),
    call: async () => {
      const reply = replies.shift();
      if (!reply) throw new Error("The fake client ran out of scripted replies");
      return reply;
    },
    toolResults: (results) => {
      sent.push([...results]);
      return [{ role: "tool", results }];
    },
  };
  return { client, sent };
}
const reply = (outcome: ModelReply["outcome"], toolCalls: ModelReply["toolCalls"] = [], text = ""): ModelReply =>
  ({ outcome, stopReason: outcome, text, toolCalls, message: { outcome, text, toolCalls } });
const tools = [getTicketTool({ get: async (id) => (id === "T-1042" ? { title: "Login fails" } : undefined) })];

test("sends bad input back as an error result, then returns the answer", async () => {
  const { client, sent } = fakeClient([
    reply("toolCalls", [{ id: "call_1", name: "get_ticket", input: { ticket_id: 42 } }]),
    reply("final", [], "I need a valid ticket id."),
  ]);
  const answer = await runAgent({ client, system: "", task: "Triage T-1042.", tools, maxTurns: 10 });
  assert.equal(answer, "I need a valid ticket id.");
  assert.deepEqual([sent[0][0].callId, sent[0][0].isError], ["call_1", true]);
});

test("throws at the turn cap instead of inventing an answer", async () => {
  const ask = () => reply("toolCalls", [{ id: "call_1", name: "get_ticket", input: { ticket_id: "T-1042" } }]);
  const { client } = fakeClient([ask(), ask(), ask()]);
  await assert.rejects(runAgent({ client, system: "", task: "Triage T-1042.", tools, maxTurns: 3 }),
    (error) => error instanceof AgentLoopError && error.reason === "turnCap");
});
```

These tests prove the loop's logic only. They prove nothing about the model's choices (that is evals, agent-harden-evals), and nothing about the adapter's field mapping. To check the adapter, save one real reply of each kind (final, tool calls, cut off) as a fixture and assert what the adapter maps it to.

## Reference

**Vendor notes, as of November 2026.** Field names change; check current docs with your documentation lookup tool before relying on any of this.

| Neutral term | Anthropic Messages API | OpenAI Responses API | OpenAI-compatible Chat Completions (DeepSeek, Kimi, others) |
|---|---|---|---|
| Tool definition | `name`, `description`, `input_schema` | `type: "function"`, `name`, `description`, `parameters`, `strict` | `type: "function"`, `function: { name, description, parameters }` |
| Tool call | `tool_use` content block with `id`, `name`, `input` | output item `type: "function_call"` with `call_id`, `name`, `arguments` | `message.tool_calls[]` with `id`, `function.name`, `function.arguments` |
| Arguments arrive as | An object | A JSON string: decode it inside the try | A JSON string: decode it inside the try |
| Tool result | `tool_result` blocks with `tool_use_id`, `content`, `is_error`, all in one user message, before any text in it | input item `function_call_output` with `call_id` and the output text | one message per call with `role: "tool"`, `tool_call_id`, `content` |
| Final answer | `stop_reason` is `end_turn` | a response with no `function_call` items | no `tool_calls`; also read `finish_reason` |
| Other stop reasons | `max_tokens`, `stop_sequence`, `refusal`, `model_context_window_exceeded`, and `pause_turn` for vendor-run tools | not listed in the function-calling guide | read `finish_reason` |
| Keep the reply whole | "add the response's `content` unchanged as an `assistant` message" ([source](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)) | "any reasoning items returned in model responses with tool calls must also be passed back with tool call outputs" ([source](https://developers.openai.com/api/docs/guides/function-calling)) | DeepSeek: with tools in the request, "If your code does not correctly pass back `reasoning_content`, the API will return a 400 error." ([source](https://api-docs.deepseek.com/guides/thinking_mode)). Kimi: "Return the complete assistant message unchanged" |
| SDK loop helper | Tool runner; its input is "not validated at runtime" | Agents SDK runs the loop in your process | Use the OpenAI SDK with a different base URL, key and model name |

Compatible endpoints accept a subset of the original API and can ignore unsupported fields silently. DeepSeek's Anthropic-format endpoint, for example, ignores `is_error`, which is why the error text must stand on its own.

## Checklist

- [ ] The adapter is the only file that imports the vendor SDK, and the loop receives the client as a parameter.
- [ ] The reply message goes into the history unchanged, before any tool runs.
- [ ] Only a final answer returns; every other stop reason and an empty tool-call reply throw with the stop reason.
- [ ] `maxTurns` is set by the caller, and reaching it throws.
- [ ] Every tool call gets exactly one result with its call id, including unknown tools, undecodable arguments and thrown errors.
- [ ] Every tool parses its input at run time and throws a message that says what valid input looks like.
- [ ] No tool that changes anything runs without a gate from agent-build-approval.
- [ ] The key comes from the environment, injected by a secret manager, and appears in no file or log.
- [ ] Fake-client tests pass for: final answer on the first call, one tool round then an answer, two calls in one reply answered in order, an unknown tool, invalid input, a thrown tool error, a non-final stop reason, and the turn cap.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A 400 error on the call after a tool turn, with a reasoning model | The history holds a rebuilt reply that dropped a reasoning field. Push the vendor's reply object unchanged. |
| An error that tool call ids have no matching results | A result is missing: the code ran only the first call, or skipped a failed one. Send one result per call id. |
| A 400 error about message order after tool results | The vendor's result format is wrong, for example text placed before the results. Fix `toolResults` in the adapter from the vendor's docs. |
| The run crashes when a tool fails | The tool error escaped the loop. Catch it in the call runner and return an error result. |
| The run returns half a sentence | A cut-off reply was treated as final. Return only on the final-answer outcome. |
| The model repeats the same failing call | The error text does not say how to fix the input. Make it actionable; repeat detection belongs to agent-harden-guardrails. |
| The model never calls tools on a self-hosted model, and tool markup appears in the text | The model server was started without the tool-call parser that matches the model. Use the serve command from the model's own docs. |
| Fake-client tests pass, but the real run fails | The fakes do not check the adapter's field mapping. Add fixture tests built from saved real replies. |
| Cost per run grows much faster than the number of turns | Each call resends the whole history. Shrink tool results and lower the cap; see agent-build-context for caching and long histories. |
