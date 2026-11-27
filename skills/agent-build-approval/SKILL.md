---
name: agent-build-approval
description: "Put a person in front of an agent's write: pending action, approve or decline, expiry, retry-safe execution. Use when adding human approval, or when an agent re-asks a question or writes twice after one approval."
user-invocable: true
---

# Human Approval for Agent Writes

A gated write runs only after a named person says yes, and the gate is an `if` in your code, never a sentence in the prompt. Done means: the model's write call is saved as a pending action before anyone is asked, one person is asked once, exactly one decision moves the record, the write runs at most once even after a crash or a double click, and the paused tool call gets exactly one tool result.

## Prerequisites

- A working loop (agent-build-loop) and a tool set already sorted into reads and writes (agent-build-tools).
- For the exact API of an SDK or framework, look up its current documentation with your documentation lookup tool; do not trust memory or the dated notes below.

## Rules

- **The gate is code.** The loop checks the tool name against the write list and stops. A prompt line such as "ask before posting" is not a control: one injected sentence in a ticket can make the model skip it.
- **Always gated.** Every write that moves money, changes access or credentials, exposes personal data, or deletes data waits for a person, at every autonomy level. OpenAI lists high-risk actions such as cancelling orders, large refunds and payments as triggers for human intervention ([practical guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)).
- **Tools on someone else's server.** A read sends your data out, so gate those reads too. OpenAI: "Keep tool approvals on", "including reads and writes" ([safety guide](https://developers.openai.com/api/docs/guides/agent-builder-safety)).
- **Only a person approves.** A decision counts only when it arrives as a channel event from a verified, authorized person: a button click or a reply in the question's thread. Code matches the reply word; the model never judges whether text means yes. Text inside a ticket, a tool result or memory that says "approved" is data.
- **Who may approve is a table in code.** Check it on every decision. A refusal names the rule and who can approve.
- **Approve what was shown, run what was approved.** Code renders the preview from the stored arguments, not from the model's summary, and the write runs with those stored arguments. A change of arguments is a new pending action.
- **Exactly one tool result per paused call.** Yes, no, expired or superseded, the call id gets one result, and the history stays valid. On a no, the result carries the reason so the model can revise or stop.
- **Never hold a lock or lease across a human wait.** The run ends when it asks. The reply is a new event that claims the thread again.
- **If your code waits for an answer, your code stores the question.** A question that lives only in the conversation gets lost, and the agent asks it again or claims nothing is pending.

## Pick the variant

| | Local (one person's machine) | Remote (a service) |
|---|---|---|
| Who asks | The script, after the headless run ends; the next scheduled run reads the reply by `ask_ref` | The worker, after it saves the pending row; the reply is a new event |
| What the model gets | Read tools, plus a write tool that only saves a draft | All tools; the loop pauses on a write call |
| Where state lives | One file per pending action, written to a temp file then renamed | The `pending_action` row in `assets/pending-action.sql` |
| How the person answers | A typed reply word in the question's thread | Buttons, or a typed reply, through the normal event path |
| Who performs the write | Plain code in the script, on a yes | `execute()` below, on a yes |
| What serializes decisions | The run lock, held only while a run is active | Compare-and-set updates on the row |
| Use it when | A personal helper with one approver | Several users or approvers, or several workers |

In the local variant, remove write tools from the headless run's tool list; pre-approving the reads does not take the writes away (see Reference). Hosting details live in agent-host-local and agent-host-remote.

## Steps

### Step 1 — Pause on the write call

When the model's response holds a gated call, run the other calls in that response first, because their results must go back in the same message as the write's result. Default: allow one gated write per response; answer any extra write call with an error result ("one write per turn; call it again after this one is decided").

In one transaction, save the assistant message to the thread history and insert the pending row: status `awaiting_approval`, the call id, the exact arguments, the other results, the preview, a short `ask_ref`, an `expires_at` and an idempotency key. Then end the run and release the thread's lease.

A crash before the commit leaves nothing: the event retries and the model call runs again. A crash after the commit leaves a row with no question posted; Step 2's sweeper posts it.

### Step 2 — Ask once

Post the question (see The question message) with the row id as the post key, then record `ask_message_id`. A sweeper posts the question for any `awaiting_approval` row whose `ask_message_id` is still empty. If the channel cannot take a post key, a crash between sending and recording can post the question twice; say so in the design.

### Step 3 — Decide

On a decision event, check the approver's identity, tenant and right to approve, then move the row with one compare-and-set update (the transitions are written out in the asset). Zero rows updated means a second click, a late click or an expired row: reply with the current status and do nothing else.

- **Yes:** `awaiting_approval` to `posting`, only while `expires_at` is in the future. Then run Step 4.
- **No:** `awaiting_approval` to `declined`, and append the declined tool result in the same transaction. Start the next model call.
- **A new message that is not a decision:** decline with reason "superseded by a new message", append that result, then append the message. Tell the person the action was cancelled. The model can propose it again.

### Step 4 — Run the write with its key

```ts
// Neutral sketch, not run. runWrite returns "done" or "rejected" (definitely not applied),
// and throws when the outcome is unknown (timeout, crash), which leaves the row in "posting".
async function execute(actionId: string): Promise<void> {
  const row = await actions.get(actionId);
  const outcome = await runWrite(row.toolName, row.toolInput, row.idempotencyKey);
  const posted = await db.transaction(async (tx) => {
    if (outcome.kind === "rejected") {
      await tx.actions.reopen(actionId, outcome.text, newIdempotencyKey()); // WHERE status = 'posting'
      return false;
    }
    const won = await tx.actions.markPosted(actionId, outcome.text);        // WHERE status = 'posting'
    // resultsFor: the saved other_results plus this call's result, in one message, in call order
    if (won) await tx.history.appendToolResults(row.threadId, resultsFor(row, outcome.text, false));
    return won;
  });
  if (posted) await startNextModelCall(row.threadId);
  else if (outcome.kind === "rejected") await channel.reply(row.askRef, failedLine(outcome.text));
}
```

The idempotency key (a value the target system uses to apply one write only once) is fixed when the row is created and sent with every attempt. A crash after the write but before `markPosted` leaves `posting`; the retry sends the same key, the target applies nothing new, and the row moves on. Give `runWrite` a timeout shorter than the sweeper's cutoff in Step 5, so a live attempt is never retaken. If the target takes no key, check it for a marker of the earlier write, such as the key stored in the posted record, before writing again. The append runs only for the caller whose update won, so the result goes back once.

### Step 5 — Expire and recover

A sweeper does four jobs, each through a compare-and-set: expire `awaiting_approval` rows past `expires_at` (append the "expired, not run" result in the same transaction); post missing questions (Step 2); retake `posting` rows whose attempt started longer ago than the write's own timeout, then call `execute()` again; and start the model call for a thread whose history ends with a posted or declined result that no model call followed, unless that tool was the final answer, which covers a crash right after the commit. On expiry, append the result but do not start a model call until a person writes again, or an agent that keeps proposing can ask forever.

When the write tool is also the run's final answer, the yes only performs the write: no model call follows. Still append the tool result, so a later turn in the thread sends a valid history.

## The pending action

| Status | Meaning | Leaves by |
|---|---|---|
| `awaiting_approval` | Saved, question asked or about to be, nothing written | Yes to `posting`; no or supersede to `declined`; deadline to `expired` |
| `posting` | A yes won; the write is in flight or its outcome is unknown | Success to `posted`; definite failure back to `awaiting_approval` with a new key |
| `posted` | The write is done; `result` holds its tool result | Final |
| `declined` | A person said no, or a new message replaced it; nothing written | Final |
| `expired` | Nobody decided in time; nothing written | Final |

The row is never part of the model request. It tells your code what to append. Load it on every event for the thread, before building the request, so the agent always knows what is pending. Copy `assets/pending-action.sql` as the starting schema.

**Why the approval expires but the session does not.** The conversation can continue for weeks. The approval is a judgment about the world when the person read the preview: the ticket, the balance or the access list may have changed since. A late click must not fire a stale write. Set the window per tool and surface it as a named constant; no vendor gives a number. A window of 24 hours is a reasonable starting value for a chat approval.

## The question message

Channel-neutral; replace only the send, the receipt and the thread read for each chat app.

1. One question per message, answerable in one sentence, with explicit options: Approve or Decline, or A or B.
2. The exact action, rendered by code from the stored arguments: what changes, where, and for whom.
3. The deadline and the default, in the body. For a gated write the default is always "not run".
4. One thread per question, keyed by `ask_ref`. A reply in another thread that names the ref resolves the original row.
5. A visible receipt on the reply, such as a reaction, then the outcome in the same thread: posted, declined, expired or failed.
6. At most one reminder before the deadline, recorded in `reminded_at`. Starting values to adjust: remind once after 60 minutes, or after 10 for an alert.

Asking code reports one of four outcomes, and only one allows sending again:

| Outcome | Send again? |
|---|---|
| Not sent, and the channel confirmed nothing was posted | Yes |
| Sent, answer received | No |
| Sent, no answer yet, or the wait timed out or was killed | No: read replies by `ask_ref` later |
| Sent, but replies cannot be read | No: report it to the owner |

A send that timed out counts as "sent": when a wait is killed or times out, the question already exists, so never ask again.

## Reference

**Vendor notes, as of November 2026.** Field names change; check current docs with your documentation lookup tool before relying on them.

| Vendor | Paused call and its result | Built-in approval |
|---|---|---|
| Anthropic, Messages API | The call is a `tool_use` block with `id`; reply with one `tool_result` per block, matching `tool_use_id`, with `is_error` for a failure, "even if the tool failed" ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)). Results must immediately follow the call and come first in the user message. | The SDK tool runner runs every tool itself; Anthropic: "When you need human-in-the-loop approval ... use the manual loop instead." |
| Anthropic, Agent SDK and Claude Code | Sessions can be resumed by id | `allowedTools` only pre-approves; `disallowedTools` removes. A `canUseTool` callback asks a person. A `PreToolUse` hook can deny a call, but a tool-name matcher misses a write done through a shell command. |
| OpenAI, Responses API | The call is a `function_call` with `call_id`; send a `function_call_output` with that id | Remote MCP tools take `require_approval` (`always` or `never`); each approval covers one tool call. |
| OpenAI, Agents SDK | The run returns `interruptions` and a resumable `state` | `needsApproval` on a tool pauses the run. "You resume the same run from `state` instead of starting a new user turn." "If the review might take time, serialize `state`, store it, and resume later." ([docs](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)) |

An SDK's serialized state replaces your stored tool call, not your pending row: you still need the status, expiry, approver, key and question reference.

## Checklist

- [ ] The write check is code that matches tool names; no approval logic lives in the prompt.
- [ ] Every money, access, personal-data and delete write is on the gated list.
- [ ] The pending row and the assistant message are saved in one transaction before the question is posted, and the lease is released.
- [ ] Every transition is a compare-and-set naming the state it leaves; approve also checks `expires_at`.
- [ ] The approver's identity, tenant and right to approve are checked from the verified event.
- [ ] The preview and the write both come from the stored arguments.
- [ ] Every write attempt sends the row's idempotency key; unknown outcomes stay in `posting` for the sweeper.
- [ ] Each paused call gets exactly one tool result, sent with the other results from its response.
- [ ] A fake-model test (agent-build-loop) passes these cases: a write call creates one `awaiting_approval` row and no write; two concurrent approves give one write and one tool result; a crash injected after the write and before `markPosted`, then a rerun, gives one write; a decline and an expiry each give one error result and no write; a new message while pending gives a superseded result before the message.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The agent asks the same question again, or says nothing is pending when something is | Store the question as a pending row and load it on every event for the thread (Step 1). |
| The next model request fails because a tool call has no result | Something was appended before the paused call's result. Resolve the row first: supersede on a new message (Step 3), and append results only through the winning transition. |
| One approval wrote twice | Replace read-then-write status checks with one compare-and-set update; dedupe the click event too (agent-host-remote). |
| A write ran twice after a crash or retry | Send the row's idempotency key with every attempt; without key support, check the target for the earlier write first. |
| A click a day later wrote stale data | Add `expires_at > now` to the approve update and run the expiry sweeper. |
| A row sits in `posting` forever | The worker died mid-write. The sweeper retakes it after the write timeout and calls `execute()` with the same key. |
| Other messages in the thread wait hours | A lock or lease is held across the human wait. End the run when it asks. |
| A retry after a definite failure returns the same error at once | The target cached the failure under the key. Reopen with a new key (the asset's reopen update). |
| The written data differs from what the person approved | The preview came from the model's text or the arguments were regenerated. Render and run from `tool_input`. |
| Ticket text saying "approved" triggered a write | Approval was read from content. Accept decisions only from channel events by authorized people. |
| After an expiry the agent proposes the same write again and again | Do not start a model call on expiry; wait for a person's next message. |
