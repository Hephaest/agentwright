---
name: agent-host-local
description: "Run an agent on one person's machine: headless harness, schedule, run lock, writes gated in the script. Use when scripting or scheduling a local agent. To run it as a service, use agent-host-remote."
user-invocable: true
---

# Running an Agent on Your Own Machine

A local agent is an agent loop on one person's machine plus three additions: a trigger that starts it, a channel where its answers go, and a way to ask a human before it writes. It is the fastest route to a useful agent, because the machine already has the logins and command-line tools the agent needs. The success state: a scheduled, unattended run that reads with your tools, hands in a typed result, runs one at a time, keeps no secret in any file, and makes no write until a person says yes in the channel.

## Prerequisites

- A loop that runs without a chat screen: a coding-agent harness in headless mode, or your own loop (agent-build-loop). Whether local is the right home, and harness versus own loop, is agent-plan-architecture's call.
- The read tools and a final-answer tool that only validates and saves (agent-build-tools).
- For the exact flags of any harness or SDK, look up its current documentation with your documentation lookup tool; the vendor notes below are dated.

## Anatomy

Everything in this table runs as you, with your logins. That is the source of both its power and its limits.

| Part | What it is | Default |
| --- | --- | --- |
| Trigger | What starts a run | A schedule (cron or launchd) that polls the source of truth, so a run after downtime catches up |
| Loop | A harness is the program around the model that runs the loop, owns the tools and enforces permissions. Headless means prompt in, result out, no chat screen | The harness's headless mode, or your own loop in the same place |
| Tools | Your functions or a small tool server (an MCP server: a process that offers tools over a standard protocol) | Reads only, plus the final-answer tool |
| State | Records on disk, one per work item | Write a temporary file, then rename it over the old one, so a crash never leaves half a record |
| Channel | A chat thread, often posted to through a webhook (a URL the chat app gives you; an HTTP POST to it puts a message in one chat) | One message per event, conclusion on the first line |
| Human | The person who approves writes and steers | Replies in the thread; only listed people count |

## Build order

Follow this order. Each step is tested by hand before the next is added.

1. **Run the harness headless on one real task, by hand.** Read what it did: which tools it called, what it printed, its exit code. Ask for machine-readable output so a script can parse it.
2. **Give it your tools, and only those.** Remove every built-in tool the job does not need; a read-and-report agent needs none. Load tool servers only from a config file you pass on the command line, never from whatever the folder happens to contain. The final answer is a tool call that validates the result's shape and saves it to a path the script chose. It posts nothing.
3. **Add the channel.** Post the result to a thread. Each question gets its own thread and a short reference, states options, a deadline and the default if nobody answers, and is answerable in one sentence.
4. **Add the trigger last.** A schedule that runs a broken agent only produces broken output faster. Set the environment explicitly, take a lock, cap each run with a timeout, and log to a file.
5. **Gate every write in the script.** The agent run ends with a pending record and a question. A later run reads the reply and posts only on yes. The approval is an if statement in code, never a sentence in the prompt. The pending-action record, its expiry and who may approve belong to agent-build-approval.

### The run script

The recommended shape, as a sketch against small interfaces you write for your harness, chat app and target system. Never claim it is tested until you have run it.

```ts
interface Harness { run(prompt: string, resultPath: string, timeoutMs: number): Promise<number> } // exit code
interface Channel { ask(ref: string, text: string): Promise<void>; answer(ref: string): Promise<"yes" | "no" | null> } // counts only allowed people
interface Target { listOpen(): Promise<string[]>; hasPost(id: string): Promise<boolean>; post(id: string, v: Verdict): Promise<void> }
type Rec =
  | { id: string; status: "failed" | "rejected" | "done" }
  | { id: string; status: "asking" | "asked" | "posting"; verdict: Verdict };
interface Records { get(id: string): Rec | undefined; open(): Extract<Rec, { verdict: Verdict }>[]; save(r: Rec): void }

const RUN_TIMEOUT_MS = 10 * 60_000; // you set this; it must exceed a normal run

async function runOnce(h: Harness, ch: Channel, t: Target, db: Records, alert: (m: string) => void) {
  // 1. Finish earlier work. Never block on a human here; the reply is read on a later run.
  for (const r of db.open()) {
    if (r.status === "asking") { await ch.ask(r.id, question(r)); db.save({ ...r, status: "asked" }); continue; }
    if (r.status === "posting" && (await t.hasPost(r.id))) { db.save({ id: r.id, status: "done" }); continue; }
    const answer = r.status === "posting" ? "yes" : await ch.answer(r.id);
    if (answer === "no") db.save({ id: r.id, status: "rejected" });
    if (answer !== "yes") continue;
    db.save({ ...r, status: "posting" }); // mark before the write, so a crash is detected
    await t.post(r.id, r.verdict);        // the only write, in plain code
    db.save({ id: r.id, status: "done" });
  }
  // 2. New items: the agent only reads and hands in a verdict.
  for (const id of await t.listOpen()) {
    if (db.get(id)) continue;
    const path = `runs/${id}.json`;
    removeIfExists(path); // a stale file must never pass as this run's result
    const code = await h.run(`Triage ticket ${id}. Hand in your verdict with post_triage.`, path, RUN_TIMEOUT_MS);
    const verdict = code === 0 ? parseVerdict(path) : null; // validate the shape; null on any problem
    if (!verdict) { db.save({ id, status: "failed" }); alert(`Triage of ${id} failed; clear its record to retry.`); continue; }
    db.save({ id, status: "asking", verdict });
    await ch.ask(id, question({ id, status: "asking", verdict }));
    db.save({ id, status: "asked", verdict });
  }
}
```

Why the order holds under a crash between any two lines:

- **A crash may repeat an ask; it never repeats a write.** A record is saved as `asking` before the question goes out, so a crash re-sends the question at worst. A record is saved as `posting` before the write, and a `posting` record is checked against the target before any retry. If the target cannot be checked, alert the owner instead of retrying.
- **The record is the "seen" list.** An item without a record is re-run from scratch, which is harmless because the agent only reads.
- **No lock is held across a human wait.** The run asks and moves on, so one slow reply never blocks the other items or the next run.

Wrap `runOnce` in a lock. Create a lock directory, because creating a directory either succeeds or fails in one step, so a second run sees it and exits. Remove it in a `finally`. A killed process leaves the lock behind: when the lock is older than the longest possible run, alert the owner and exit. Never delete the lock automatically, because two runs that both see it as stale can both delete it and both proceed.

### The pre-tool-use guard

A pre-tool-use hook is your program that the harness calls with each tool call before it runs; it may deny the call with a reason. Put every rule in a pure function and keep input and output at the edge, so each rule gets a unit test without a harness.

```ts
type ToolCall = { tool: string; input: Record<string, unknown> };
type Decision = { kind: "allow" } | { kind: "deny"; reason: string };

export function decide(call: ToolCall): Decision {
  if (WRITE_TOOLS.has(call.tool)) return { kind: "deny", reason: "Writes run in the script after approval." };
  if (call.tool === "shell" && /\|\s*(ba)?sh\b/.test(String(call.input.command ?? "")))
    return { kind: "deny", reason: "Piping text into a shell is not allowed." };
  return { kind: "allow" };
}

export function runGuard(io: { read(): string; write(s: string): void },
                         parse: (raw: unknown) => ToolCall, reply: (d: Decision) => string): void {
  let decision: Decision;
  try { decision = decide(parse(JSON.parse(io.read()))); }
  catch { decision = { kind: "deny", reason: "The guard could not read this tool call." }; } // fail closed when unattended
  io.write(reply(decision)); // the harness-specific output shape lives only in reply()
}
```

A guard that reads command text is a guardrail, not a lock: a script file the agent writes and then runs slips past it, and a hook scoped to one tool does not see the same action done through another. One vendor's docs give the example: "If Claude writes `.env` with a Bash command, the hook doesn't run" ([Agent SDK hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)). The real limit is the tool set you removed in step 2 and, where available, a sandbox. Layered guardrails are agent-harden-guardrails.

## Secrets and identity

- **No secret in any file.** Not in the script, the crontab, the tool config or the repo. Keep it in the operating system's secret store or a password manager, and hand it to the one command that needs it at run time.
- **A webhook URL is a credential.** Anyone who has it can post into the chat. Never put it in a message, a card body or a log; if it leaks, reset it.
- **Set an API key only for the invocation that needs it**, never for the whole job, so tools and scripts the run starts do not inherit it.
- **Read the reply identity separately from the post identity.** A write-only webhook for posting and a separate login for reading replies keeps one leaked secret from granting both.
- **The agent can reach whatever you can.** Give its tools the narrowest login you have, and say in each answer what it did not check.

## Limits of local

| Limit | What it means | Signal to move to agent-host-remote |
| --- | --- | --- |
| One machine | When it sleeps or goes offline, the agent stops, and nobody else can restart it | People other than the owner wait on its answers, or it must answer while the owner is away |
| One identity | It acts with the owner's logins, so it can reach everything the owner can | It needs its own scoped credentials, or acts for people other than the owner |
| One run at a time | State is local files and a lock: no queue, no second worker, no failover | Work must not be lost while the machine is off, or a chat platform expects an acknowledgement within seconds |

While it stays local: post a notice when the machine will be away, and alert the owner whenever a run fails or times out, so silence never looks like work.

## Reference

### Vendor notes, as of November 2026

Check current docs with your documentation lookup tool before relying on any row.

| Need | Claude Code headless | Codex non-interactive |
| --- | --- | --- |
| Run once | `claude -p "<prompt>"` | `codex exec "<prompt>"` |
| Parse the result | `--output-format json`; add `--json-schema '<schema>'` and read `structured_output`, which is absent if the run ended without valid output | Progress on stderr, final message on stdout; `--json` for a JSONL event stream; `--output-schema <file>`; `-o <file>` writes the last message |
| Remove tools | `--tools ""` removes every built-in tool; it does not affect tool-server tools, so add `--disallowedTools "mcp__*"` or load only your own servers | Default sandbox is read-only; `--sandbox workspace-write` allows edits |
| Pre-approve | `--allowedTools` only skips the prompt; the CLI reference says "To restrict which tools are available, use `--tools` instead" | Not applicable: the sandbox mode is the limit |
| Folder config | "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted." Use `--bare`, or `--strict-mcp-config --mcp-config <file>` to load only the servers you name | Project config and project tool servers load only for trusted projects; "Project-defined MCP servers can run commands outside the sandbox" |
| Unattended auth | `--bare` never reads the login or keychain and needs `ANTHROPIC_API_KEY`; the docs call `--bare` "the recommended mode for scripted and SDK calls" | Reuses the saved CLI login; `CODEX_API_KEY` for CI, set only on the invocation that needs it |
| Caps and prompts | `--max-turns` and `--max-budget-usd` (print mode only); a call that needs approval is denied unless something approves it | Must run inside a git repository unless `--skip-git-repo-check`; `--ephemeral` skips saving session files |
| Exit | 0 on success, non-zero on failure; a failure inside the run is printed as the result on stdout | Final message on stdout |

Sources: [Claude Code headless](https://code.claude.com/docs/en/headless), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference), [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Checklist

- [ ] The run was done by hand, headless, on one real task before any trigger existed.
- [ ] The agent's tool list holds only your read tools and the final-answer tool; built-in and folder-supplied tools are removed.
- [ ] Tool servers and hooks come only from config you pass or own; the run never starts in a folder you have not read.
- [ ] The final-answer tool saves to a path the script chose and posts nothing.
- [ ] Every write is in the script, after a yes read from the channel; no prompt sentence stands in for the gate.
- [ ] The schedule sets PATH and every other variable it needs, takes a lock, and caps each run with a timeout.
- [ ] No secret appears in the script, crontab, tool config, logs or messages.
- [ ] A failed or timed-out run alerts the owner.
- [ ] Verified by hand: start two runs at once and the second exits on the lock; kill a run after a yes but before its record reaches `done`, run again, and the target shows exactly one post.

## Troubleshooting

| Symptom or mistake | Fix |
| --- | --- |
| The agent used a tool you never listed | An allowlist pre-approves; it does not restrict. Remove unwanted tools from the tool set, deny them, or sandbox the run |
| A headless run executed hooks or started tool servers from the folder | Headless modes may load the folder's own config without a trust prompt. Use the harness's bare mode or pass an explicit tool-server config, and run only in folders you own |
| Works in your terminal, fails from cron with "command not found" | Cron starts with a short PATH. Set PATH at the top of the crontab or use absolute paths |
| Two runs overlap and handle the same item | Take a lock as the first step and exit if it exists |
| The lock stays after a crash and every run exits | Alert when the lock is older than the longest run; the owner removes it after checking nothing is running |
| A verdict landed on the wrong item | The result path came from a stale file or from the model. Delete the file before each run and let the script choose the path |
| The same question was asked repeatedly | The reply was not recorded against its reference. Read replies by the original reference; never re-ask after a wait times out |
| A write ran twice after a crash | Save `posting` before the write and check the target before retrying a `posting` record |
| The run hangs on a permission prompt | Nobody is there to answer. Give the run only tools that need no prompt, and keep approval in the script |
| Colleagues report the agent "is not responding" | Alert the owner on every failed or timed-out run, and post a notice before planned downtime. If people depend on it, move to agent-host-remote |
