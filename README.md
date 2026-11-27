# agentwright

Skills that teach a coding agent how to design, build, host and harden an AI agent: a model that calls tools in a loop. They are vendor-neutral, so they hold whether you use Anthropic, OpenAI, Google or an open model, and whether you write the loop yourself or use an SDK.

Each skill covers one step and loads only when that step comes up.

## Install

**Claude Code**

```bash
claude plugin marketplace add Hephaest/agentwright
claude plugin install agentwright@agentwright
```

**Codex**

```bash
codex plugin marketplace add Hephaest/agentwright
codex plugin add agentwright@agentwright
```

Then ask your agent to plan or build an agent, or start from the entry skill: `/agentwright:agent-overview` in Claude Code.

## Skills

| Stage | Skill | What it covers |
|---|---|---|
| Start | `agent-overview` | Which skill to load, and the rules every agent must meet |
| Plan | `agent-plan-architecture` | Single call, workflow or agent; where the loop comes from; local or remote; one agent or several |
| Build | `agent-build-loop` | The tool-calling loop: exits, turn cap, tool errors as results, tests with a fake model |
| Build | `agent-build-tools` | Tool descriptions, arguments, results, errors, read or write classification |
| Build | `agent-build-context` | System prompt, session state, memory, long history, caching |
| Build | `agent-build-approval` | A person in front of a write: pending action, expiry, retry-safe execution |
| Host | `agent-host-local` | One person's machine: headless harness, schedule, run lock |
| Host | `agent-host-remote` | A backend service: acknowledge, deduplicate, queue, lease, reply once |
| Harden | `agent-harden-evals` | Eval cases, graders, the eval loop, traces |
| Harden | `agent-harden-guardrails` | Guardrail layers, hard limits, prompt injection, autonomy levels |

## What to expect

- **Guidance, not a framework.** The skills are instructions and decision tables. They install no runtime code.
- **Code is unrun sketches.** The TypeScript and SQL show the shape of a solution against a small neutral interface. Type-check and test them in your project.
- **Sources are cited.** Quotations and figures attributed to a vendor or author link to the original. Anything that could not be traced is marked UNVERIFIED.
- **Vendor notes are dated.** Product names, field names and limits sit in blocks labelled "Vendor notes, as of November 2026". Check current documentation before relying on them.

## Update

**Claude Code**

```bash
claude plugin update agentwright@agentwright
```

**Codex**

```bash
codex plugin marketplace upgrade agentwright
codex plugin add agentwright@agentwright
```

The first Codex command refreshes the marketplace; the second installs the new version from it.

## Contributing

Issues and pull requests are welcome. The rules for editing a skill are in [AGENTS.md](AGENTS.md).

## Licence

[MIT](LICENSE)
