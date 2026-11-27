# Idempotency for a Remote Agent

Idempotent means doing it twice has the same effect as doing it once. A remote agent must be idempotent because everything around it repeats: chat platforms retry a slow acknowledgement, queues deliver a job at least once, and workers crash mid-run. This file is the full design: where the event id is recorded, the tables, the atomic claim, the sweeper, a key per write, and every failure case walked through.

- [Where to record the event id](#where-to-record-the-event-id)
- [Tables](#tables)
- [Handler: record, then enqueue](#handler-record-then-enqueue)
- [Worker: claim, run, write down, post, finish](#worker-claim-run-write-down-post-finish)
- [Post once](#post-once)
- [Sweeper](#sweeper)
- [A key per write](#a-key-per-write)
- [Failure walk-through](#failure-walk-through)
- [Settings to choose](#settings-to-choose)

## Where to record the event id

The rule: every inbound event has one unique id, and you record it in one place before you act on it. Use the platform's own delivery or event id, prefixed with the source and the tenant (`slack:<tenant>:<id>`, `github:<tenant>:<id>`), so two platforms or two tenants can never collide. Without the tenant, a platform whose ids are unique only inside one workspace would let one tenant's event be dropped as another's duplicate. For a schedule, the id is the tenant (when the schedule belongs to one), the job name and the planned fire time. For a promised follow-up, it is the follow-up row's id. A scheduled or follow-up run goes through the same record-then-enqueue step as a webhook, so the worker always finds a run row.

| Option | How | Catch |
|---|---|---|
| The queue is the record | The job id is the event id; the queue refuses a second job with the same id | A queue forgets a finished job after a while, so a late duplicate gets in. Keep finished jobs longer than the platform's retry window. |
| The database is the record | Insert the event id into a column with a unique constraint | Two systems must agree. Deleting the row when the enqueue fails is not safe either: a crash before the delete loses the event. |
| Both, with one id (default) | A `runs` row keyed by the event id holds the status; the job id is the same id; the worker's claim turns away a second delivery | None of its own; the sweeper below covers a failed enqueue |

The default is a design choice, not vendor guidance. You need the run row anyway, to hold the status and the pending reply, so it doubles as the permanent record.

## Tables

Postgres-style sketch, not run; adapt types to your database. Every statement uses the database clock (`now()`), never a worker's clock, so leases agree across machines.

```sql
CREATE TABLE sessions (
  session_key text PRIMARY KEY,               -- tenant:channel:thread, built once in the handler
  tenant_id   text NOT NULL,                  -- from the verified event
  messages    jsonb NOT NULL DEFAULT '[]',    -- the thread's history (agent-build-context owns its shape)
  lease_token uuid,                           -- changes on every claim; a fencing token
  lease_until timestamptz                     -- while in the future, one worker owns the thread
);

CREATE TABLE runs (
  event_id      text PRIMARY KEY,             -- source:tenant:platform id; also the job id
  tenant_id     text NOT NULL,
  session_key   text NOT NULL REFERENCES sessions,
  thread_ref    text NOT NULL,                -- where the reply goes, from the verified event
  input         jsonb NOT NULL,               -- the user's message and sender, from the verified event
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','posting','awaiting_approval','done','failed')),
  pending_reply text,                         -- written down before anything is sent
  attempts      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_unfinished ON runs (updated_at) WHERE status IN ('queued','running','posting');

CREATE TABLE sent_posts (
  post_key   text PRIMARY KEY,                -- such as <event_id>:reply
  tenant_id  text NOT NULL,
  message_id text NOT NULL,                   -- the channel's id for the sent message
  sent_at    timestamptz NOT NULL DEFAULT now()
);
```

The pending reply lives on the run row, not the session row. If it lived on the session, a second run in the same thread could claim the session after the first crashed, find the first run's reply, post it, and mark itself done without ever running.

`awaiting_approval` marks a run that ended on a gated write. The pending action itself, its expiry and its decision belong to agent-build-approval; the approver's click is a new event with its own id.

## Handler: record, then enqueue

```sql
-- One transaction. A run row coming back from the second INSERT means this delivery created the run.
BEGIN;
INSERT INTO sessions (session_key, tenant_id) VALUES ($session_key, $tenant_id)
  ON CONFLICT (session_key) DO NOTHING;
INSERT INTO runs (event_id, tenant_id, session_key, thread_ref, input)
  VALUES ($event_id, $tenant_id, $session_key, $thread_ref, $input)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING status;
-- No row back: SELECT status FROM runs WHERE event_id = $event_id;
COMMIT;
```

Then, in the handler:

1. If the status is `queued`, add a job with job id = event id. Do this whether or not this delivery created the row: it is what repairs an earlier failed enqueue.
2. If anything above throws, answer 5xx, so the platform retries. Never answer 2xx before the run row is committed and the job is added.
3. Answer 2xx. Then, only if this delivery created the row, send the fixed acknowledgement (see SKILL.md).

## Worker: claim, run, write down, post, finish

The claim is one atomic update. It succeeds only when no live lease exists, and it issues a new token. The worker sketch's `claimFor(eventId)` reads the run's `session_key`, then runs this update.

```sql
UPDATE sessions
SET lease_token = gen_random_uuid(),
    lease_until = now() + make_interval(secs => $lease_seconds)
WHERE session_key = $session_key AND (lease_until IS NULL OR lease_until < now())
RETURNING lease_token;                        -- no row: another run holds the thread; retry the job later
```

Under the lease, re-read the run and count the attempt:

```sql
UPDATE runs
SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
    attempts = attempts + 1, updated_at = now()
WHERE event_id = $event_id AND status IN ('queued','running','posting')
RETURNING *;                                  -- no row: done, failed or awaiting approval; release and stop
```

Every later write is fenced: it names the token, so a worker that lost its lease changes nothing.

```sql
-- Renew between steps of the run. No row: the lease was lost; stop before the next tool call.
UPDATE sessions SET lease_until = now() + make_interval(secs => $lease_seconds)
WHERE session_key = $session_key AND lease_token = $token AND lease_until > now()
RETURNING lease_token;

-- Save the turn: history and pending reply in one transaction.
BEGIN;
UPDATE sessions SET messages = messages || $turn_messages
WHERE session_key = $session_key AND lease_token = $token AND lease_until > now();
-- 0 rows: ROLLBACK, post nothing, and let the job retry.
UPDATE runs SET status = 'posting', pending_reply = $reply, updated_at = now()
WHERE event_id = $event_id AND status = 'running';
-- 0 rows: the run was marked failed meanwhile. ROLLBACK and post nothing.
COMMIT;

-- Just before the post: renew once more (the first statement above). No row: stop; the next worker posts.

-- After the post is recorded:
UPDATE runs SET status = 'done', pending_reply = NULL, updated_at = now()
WHERE event_id = $event_id AND status = 'posting';

-- Always, last (a no-op if the lease was lost or already released):
UPDATE sessions SET lease_token = NULL, lease_until = NULL
WHERE session_key = $session_key AND lease_token = $token;
```

A busy thread is not a failure. Retry it with a delay that does not count toward the job's attempt limit, or with a high limit; the sweeper re-adds any run that is still unfinished.

Messages in one thread can run out of order when jobs retry. If order matters, the worker, once it holds the lease, processes the oldest unfinished run of that session first, then its own.

## Post once

```ts
// Neutral sketch, not run. Channel.findByMarker is optional: not every chat app can read back recent messages.
async function postOnce(key: string, threadRef: string, text: string): Promise<void> {
  if (await sentPosts.has(key)) return;                        // sent and recorded before
  const found = await channel.findByMarker?.(threadRef, key);  // sent before, but the record was lost
  if (found) return sentPosts.record(key, found.messageId);
  const messageId = await channel.send(threadRef, text, { marker: key }); // marker: hidden metadata or a footer
  await sentPosts.record(key, messageId);                      // a crash before this line is the one window left
}
```

If the chat app accepts an idempotency key on send, pass the post key and the window closes. If it can neither take a key nor be read back, a crash between `send` and `record` posts the reply twice. State that in the design rather than hiding it; recording the key before sending only trades a duplicate reply for a lost one.

## Sweeper

A small scheduled job, run every few minutes:

```sql
SELECT event_id, attempts FROM runs
WHERE status IN ('queued','running','posting') AND updated_at < now() - $stuck_after
ORDER BY created_at LIMIT 100;
```

1. For each row under the attempt limit, add the job again with job id = event id. Re-adding a live run is harmless: the queue drops the duplicate id, or the lease turns the job away.
2. If your queue ignores a new job whose id matches a failed job it still holds, retry that failed job instead of adding one.
3. At the attempt limit, set `status = 'failed'`, post one short failure note with post key `<event_id>:failed`, and alert a person.
4. Alert when the oldest unfinished run is older than a threshold. A stuck queue is invisible to users until someone complains.

The sweeper is the only thing that rescues an event whose platform has stopped retrying.

## A key per write

Every external write the run makes carries an idempotency key (a value the target system uses to apply one write only once). The key must be the same on every attempt of the run, or it protects nothing.

| Write | Key | Why it is stable |
|---|---|---|
| The final reply | `<event_id>:reply` | One reply per event |
| The failure note | `<event_id>:failed` | One per event |
| A tool write inside a durable step | `<event_id>:<step name>` | Replay returns the same model call, so the same arguments come back (durable-steps.md) |
| A tool write without durable steps | `<event_id>:<tool name>:<hash of canonical arguments>` | A rerun with the same arguments dedupes. A rerun where the model picks different arguments makes a new key and a second write, so gate such writes or make them durable steps. |
| A gated write | The pending action's own key | agent-build-approval |
| A scheduled run | `schedule:<job name>:<planned fire time>` | A double fire gives the same id |

A counter such as "the first write of the run" is not stable without durable steps: a rerun can make a different first write. If the target system takes no key, look in it for a marker of the earlier write, such as the key stored on the record, before writing again.

## Failure walk-through

| Where it fails | What the next attempt finds | Result |
|---|---|---|
| Database error or crash before the run row commits | Nothing recorded; the platform got no 2xx and retries | Normal run |
| Row committed, enqueue fails | The handler answers 5xx; the retry finds a `queued` row and enqueues | Normal run |
| Enqueue done, crash before the 2xx | The retry finds the row; the job id is already queued, or the run is past `queued` | One run |
| The platform stops retrying after a failed enqueue | A `queued` row older than the stuck threshold | The sweeper adds the job |
| Two deliveries of one event at once | One insert wins; both may enqueue the same job id | One job; any second job is turned away by the lease or by `done` |
| A second job for a run that is running | The claim returns no row | Retries later, finds `done`, stops |
| Crash after the claim, before the turn is saved | The lease expires; the retry reruns the model | Model cost paid twice; tool writes repeat with the same keys and apply once |
| A slow worker outlives its lease before the save | Its fenced save updates 0 rows | It posts nothing; the new lease holder's run counts |
| A worker's lease expires after the save, before the post | Its renewal before the post returns no row | It stops; the new lease holder posts the saved reply |
| A worker's lease expires while its send is in flight | The new lease holder finds `posting` and no recorded key | Read-back finds the marker; without read-back the reply posts twice |
| Crash after the turn is saved, before the post | `posting` with a pending reply | Posts it; no model call |
| Crash after the send, before it is recorded | `posting`; the key is not in `sent_posts` | Read-back finds the marker; without read-back the reply posts twice |
| Crash after the post is recorded, before `done` | `posting`; the key is in `sent_posts` | Skips the send, marks `done` |
| Crash after `done`, before the release | A live lease with no worker | The next run in the thread waits up to one lease length |
| Retries run out | An unfinished row | The sweeper retries, then marks `failed`, posts one note and alerts |
| A schedule fires twice | Same schedule id | One run |
| An approval click arrives twice | Same click event id | One decision, plus the compare-and-set in agent-build-approval |

## Settings to choose

No vendor gives these numbers. Name each one as a constant and choose it for your workload.

| Setting | What it bounds | Constraint |
|---|---|---|
| `LEASE_SECONDS` | How long a dead worker blocks its thread | Longer than the gap between two renewals, and longer than the send's own timeout |
| `RENEW_EVERY` | How often a live run proves it is alive | Well under `LEASE_SECONDS` |
| `STUCK_AFTER` | When the sweeper re-adds a run | Longer than a normal queue wait plus the longest allowed run, so a live run is never counted as stuck |
| `MAX_ATTEMPTS` | When a run is marked `failed` | Counts real attempts, not busy-thread retries |
| Finished-job retention in the queue | How long the queue alone dedupes | Longer than the platform's retry window |
| Run-row retention | How long a late duplicate is still caught | Your audit and privacy rules decide |
