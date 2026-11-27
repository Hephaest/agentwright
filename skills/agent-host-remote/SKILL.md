---
name: agent-host-remote
description: "Run an agent as a backend service: verify, acknowledge, deduplicate, queue, lease, reply once. Use when wiring a webhook or chat bot, or when a bot replies twice, misses a deadline or mixes tenants. For one machine, use agent-host-local."
user-invocable: true
---

# Running an Agent as a Service

A remote agent is a normal backend service whose worker runs an agent loop: events from many people arrive at once, it acts with its own identity, it must survive restarts, and nobody watches it run. Done means: every event is verified and acknowledged inside the platform's deadline, recorded once by its id, run at most once per thread at a time, and answered with one reply, even when the event arrives twice and the worker crashes at any line. The only exceptions are the two posting windows named under The worker, which need an idempotency key or a read-back from the chat app to close. Tenant isolation and safe retries are hard requirements, never trade-offs.

## Prerequisites

- A tested loop (agent-build-loop), a tool set sorted into reads and writes (agent-build-tools), and a gate on writes (agent-build-approval). Whether to go remote at all, or rent a hosted runtime, is agent-plan-architecture's call.
- For the exact API of any SDK, queue, chat platform or engine, look up its current documentation with your documentation lookup tool; do not trust memory or the dated notes below.

## The request path

A webhook is an HTTP request another system sends to your URL when something happens, such as a chat app posting an event when someone mentions your bot.

1. **Verify the signature over the raw body bytes**, before parsing. A parsed and re-serialized body will not match the signature. Reject with 401.
2. **Take the tenant, thread and event id from the signed event.** A tenant is one customer workspace sharing your service. Build the session key (`tenant:channel:thread`) and the event id (`source:tenant:platform id`) once, here. Every later key is built from the event id, so it carries the tenant.
3. **Record, then enqueue.** In one transaction, insert the run row keyed by the event id and the session row if new. Then add a job whose job id is the event id, also when a retry finds the row still `queued`, which repairs a failed enqueue. Any error answers 5xx, so the platform retries.
4. **Acknowledge.** Answer 2xx within the deadline. Then send the human acknowledgement (see Progress) only if this delivery created the run.
5. **The worker claims the thread** with one atomic update that sets a lease. If another run holds it, the job retries later.
6. **Run, then write the reply down.** Run the loop. Save the turn's messages and the pending reply in one transaction, fenced by the lease.
7. **Post once, finish, release.** Post through a wrapper that records a post key and skips a key it has sent, mark the run done, release the lease.

Never call the model in the handler. A run takes minutes and the platform waits seconds: it retries, and the user gets two or three replies. A process restart also loses work that never reached a queue. Slack's own advice: "Avoid actually processing and reacting to events within the same process. Implement a queue to handle inbound events after they are received" ([Events API](https://docs.slack.dev/apis/events-api/)).

## The worker

The default order: claim, run, write down, post once, release. Neutral sketch, not run; each store call is one SQL statement or one transaction, written out in [references/idempotency.md](references/idempotency.md).

```ts
async function handleJob(eventId: string): Promise<void> {
  const lease = await sessions.claimFor(eventId, LEASE_SECONDS); // atomic; new fencing token; null while held
  if (!lease) throw new ThreadBusy();                     // retried later, not counted as a failed attempt
  try {
    const run = await runs.startAttempt(eventId);         // re-read under the lease; null once done or failed
    if (!run) return;                                     // a duplicate job: nothing left to do
    let reply = run.pendingReply;
    if (reply === null) {                                 // a retry after the save skips the model
      const history = await sessions.history(lease);
      const turn = await runAgent(run, history, () => sessions.renew(lease)); // tools get run.tenantId
      reply = render(turn.verdict);
      await sessions.saveTurn(lease, eventId, turn.messages, reply); // fenced; throws if the lease was lost
    }
    await sessions.renew(lease);                          // throws if the lease was lost: another worker now owns the post
    await postOnce(`${eventId}:reply`, run.threadRef, reply);
    await runs.markDone(eventId);
  } finally {
    await sessions.release(lease);                        // fenced; a no-op if the lease was lost
  }
}
```

- **The pending reply lives on the run row**, not the session row, so a later run in the thread can never post an earlier run's reply as its own.
- **Renew the lease between steps, and fence every write.** A lease is a claim that expires, so a dead worker cannot block a thread forever. A fencing token is a value that changes on every claim; each write names it, so a worker that outlived its lease changes nothing and posts nothing.
- **Never hold a lease across a human wait.** A run that needs approval saves the pending action and ends; the answer is a new event (agent-build-approval).
- **Renew just before the post.** A worker whose lease expired after the save must not post, because the next worker finds the saved reply and posts it too. Keep the lease longer than the send's own timeout.
- **The windows left:** a crash after the chat app accepted the post and before the key is recorded, and a lease that expires while the send itself is in flight. Both can post the reply twice. If the app takes an idempotency key or lets you read back recent messages, both close; otherwise say so in the design.

## Idempotency

Idempotent means doing it twice has the same effect as doing it once. Assume every event arrives twice: platforms retry, queues deliver at least once, workers crash.

| Record the event id in | Catch | Use |
|---|---|---|
| The queue alone (job id = event id) | Forgets finished jobs, so a late duplicate gets in | Only when repeating a run is harmless |
| A unique database column alone | If the insert works and the enqueue fails, the retry looks like a duplicate and the event is lost | Never alone |
| Both, one id (default) | None of its own: a retry re-enqueues a `queued` row, a sweeper re-adds runs stuck too long, and the lease turns away a second job | Every agent |

Give every external write its own key that stays the same on every attempt: `<event_id>:reply` for the reply, `<event_id>:<step name>` inside durable steps. Without durable steps a rerun can choose different arguments, so a counter like "first write" is not stable. The tables, claim, sweeper, key rules and a crash-by-crash walk-through are in [references/idempotency.md](references/idempotency.md).

## Sessions and tenants

- **One thread is one conversation, in a database row.** Any job can land on any worker, and workers restart, so nothing about a conversation lives in process memory.
- **One run per thread at a time**, enforced by the lease, so two quick messages cannot write one row at once.
- **The tenant comes only from the verified event.** It rides on the run row, code passes it to every tool, and every query filters by it. No tool takes a tenant argument from the model: text the model reads can lie.
- **Everything keyed by tenant:** session keys, memory, sandbox ids, step rows and post keys.

## Progress messages

| Beat | How to build it | Rule |
|---|---|---|
| Acknowledge | Plain code, no model: a fixed message or the platform's "working" status | Sent at most once, never delays the 2xx; losing it in a crash is acceptable because the job is queued |
| Promise a time | A tool saves a follow-up row (tenant, thread, due time, note); the scheduler enqueues it when due, with `followup:<row id>` as its event id | Promise only a time that a saved row backs |
| Report | The run's final answer, posted to the thread named on the run row | Check an effect before claiming a fix; correct a wrong answer in the same thread |

A schedule is just another trigger: it enqueues a job with id `schedule:<name>:<planned fire time>`, and the same queue, worker and session store do the rest. That id makes a double fire harmless.

## Durable steps

Durable means each step's result is saved before the next starts, so a restarted run skips finished work. The worker above saves once per run, which is enough for a run of a few minutes that is cheap to repeat.

| Situation | Default |
|---|---|
| Short run, cheap to repeat | The queue retry and the saved pending reply |
| Many costly model or tool steps | A hand-written step helper: one saved row per model call and per tool call |
| Waits hours or days, fans out, or many kinds of long run | A durable execution engine |

The hand-written helper has a known gap: a crash after a step's function returns and before its result is saved runs that step twice. Engines are at-least-once too. So every writing tool must be idempotent. Helper, rules and dated engine notes: [references/durable-steps.md](references/durable-steps.md).

## Identity and sandbox

This comparison is a design judgment; no vendor page settles it.

| | Act as the bot | Act as the user |
|---|---|---|
| What it reaches | Everything granted to the bot, for every user | Only what that person can see |
| Cost | One app credential | Consent, token storage and refresh per person |
| Default when | Data is shared alike across the tenant | Visibility differs per person, or the action must be attributed to them |

- **Least privilege, per run.** monday.com: "The run's GitHub App token covers only the repos that run needs and expires after about an hour" ([post](https://engineering.monday.com/how-we-gave-ai-agents-the-keys-to-production-and-still-sleep-at-night)). Never one all-powerful token with the prompt as the only limit. Credentials never enter the model's context.
- **Code-running agents get a sandbox:** a separate, throwaway machine per run, ideally a small virtual machine with its own kernel, so a mistake cannot reach your host, secrets or network. Give it only the run's credentials, deny network by default, and cap its run time. Never run agent code in the server process next to your keys.
- **Hard limits, kill switches and prompt-injection defenses** belong to agent-harden-guardrails.

## Minimal stack

| Role | Job |
|---|---|
| Handler | Verify, record, enqueue with the event id, answer 2xx |
| Queue | One job per event, retried when a worker dies |
| Worker | Claim the thread, run, save, post once, release |
| Relational store | Sessions, runs, leases, pending replies, sent post keys, pending actions |
| Scheduler | Schedules, promised follow-ups, the sweeper |
| Tracing | One trace per event, carried from handler through queue to worker; one span (one timed step) per model call and tool call (agent-harden-evals) |
| Sandbox | Only if the agent runs code |

## Migrating from local

| Keep, almost unchanged | Rewrite |
|---|---|
| The system prompt and house style | Trigger: a webhook, a queue and a scheduler |
| Tool definitions and the code behind them | Session: files become rows keyed by thread |
| Eval cases and their expected answers | Identity: a bot account with scoped tokens, or per-user tokens |
| The loop, or the SDK that runs it | Approval: a terminal prompt becomes a message and a pending row |

Also rewrite every write tool to take an idempotency key, because jobs now retry. Find tools that quietly used your own login: on a server they fail, or tempt someone to hand them one all-powerful token.

## Reference

**Vendor notes, as of November 2026.** Platform limits and products change; check current docs with your documentation lookup tool before relying on them.

| Platform | Deadline | What happens next | Event id |
|---|---|---|---|
| Slack Events API | HTTP 2xx "within three seconds" | Three retries: almost at once, after 1 minute, after 5 minutes; hourly for 24 hours with Delayed Events on ([docs](https://docs.slack.dev/apis/events-api/)) | `event_id` |
| GitHub webhooks | "a 2XX response within 10 seconds" | A redelivery keeps the same `X-GitHub-Delivery` ([docs](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)) | `X-GitHub-Delivery` |
| Discord interactions | Initial response "within 3 seconds" | The interaction token is invalidated; a deferred reply can follow for 15 minutes ([docs](https://discord.com/developers/docs/interactions/receiving-and-responding)) | Interaction id |
| Telegram | No time stated; answer 2xx | Repeats the request and gives up "after a reasonable number of attempts" ([docs](https://core.telegram.org/bots/api#setwebhook)) | `update_id` |

On Discord the acknowledgement is the deferred HTTP response itself, not a separate message.

- **One concrete stack:** an Express route, BullMQ on Redis (a job id per event; job schedulers for cron), Postgres for every table, OpenTelemetry GenAI spans (check the conventions' stability level first). Check how long your queue keeps finished and failed job ids.
- **Hosted runtimes** run the worker, the session store and often the sandbox for you, but the trigger and fast acknowledgement, the identity and the approvals stay yours. Anthropic: "Managed Agents is not currently eligible for Zero Data Retention or HIPAA Business Associate Agreement (BAA) coverage" ([docs](https://platform.claude.com/docs/en/managed-agents/overview)). OpenAI's Agents API runs "a managed Codex harness" ([docs](https://developers.openai.com/api/docs/guides/agents)); check its data-retention terms before sending customer data.
- **Sandboxes:** E2B, Vercel Sandbox and Cloudflare Sandboxes document a small virtual machine per sandbox; Modal offers gVisor or a virtual machine; Daytona runs containers by default. Modal: pair isolation "with least-privilege credentials, a default-deny network posture, filesystem boundaries, execution [limits]" ([page](https://modal.com/resources/best-sandboxes-isolating-untrusted-agent-actions-rl)).

## Checklist

- [ ] The signature is checked over the raw bytes before parsing; the tenant, thread and reply target come only from the verified event.
- [ ] The handler makes no model call and answers 2xx only after the run row is committed and the job is added.
- [ ] The run row's key and the job id are the same event id, prefixed with source and tenant; a retry re-enqueues a `queued` row.
- [ ] The claim is one atomic update that issues a new fencing token; every later write names the token; the lease is renewed between steps and never held across a human wait.
- [ ] The pending reply is saved on the run row with the turn, in one transaction, before any post.
- [ ] Every external write carries a key that is identical on every attempt.
- [ ] A sweeper re-adds stuck runs, marks runs failed at the attempt limit, and alerts on the oldest unfinished run.
- [ ] No tool takes a tenant id from the model; every query and key is scoped by tenant; each run gets short-lived, scoped credentials.
- [ ] Every timing and retry limit is a named constant someone chose (see the settings table in the idempotency reference).
- [ ] A fake-client test passes: the same event delivered twice at once gives one run row and one reply; a crash injected after each worker step, then a retry, gives one reply and one write per key; a worker whose lease expired mid-run posts nothing; two tenants with the same thread id never see each other's history.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The bot replies two or three times to one message | The handler is slow or calls the model; the platform retried. Record, enqueue and answer 2xx in milliseconds. |
| Signature check fails on every event | The body was parsed before verifying. Verify the raw bytes. |
| An event vanished after an error | The row was committed but the enqueue failed and retries ran out. Re-enqueue `queued` rows on retry and run the sweeper. |
| Two runs wrote the same thread at once | The claim is read-then-write, or the lease expired mid-run. Use one atomic update, renew the lease, fence every write. |
| A reply posted twice after a crash | The reply was posted before it was saved, or the post key was not checked. Save the pending reply first; post through `postOnce`. |
| A message in a thread got another message's reply | The pending reply sat on the session row. Move it to the run row. |
| A thread stays blocked for minutes after a crash | Expected up to one lease length. Shorten the lease and renew more often. |
| Jobs fail with "thread busy" until they give up | Busy retries count as failed attempts. Retry busy with a delay outside the attempt limit; the sweeper covers the rest. |
| A crash mid-run repeated a tool's write | The tool has no stable key. Key it by event id and step name, or by event id, tool name and argument hash. |
| Users wait hours with no acknowledgement | A stuck or single-worker queue. Alert on the oldest unfinished run's age. |
| One tenant saw another's data | A tenant id came from the model or a key lacked the tenant. Take it from the run row; scope every query and key. |
| A rich-text reply failed to render | Validate the message format before sending; fall back to plain text. |
| The agent claimed a fix that had not worked | Check the effect with a read tool before reporting; post the correction in the same thread. |
