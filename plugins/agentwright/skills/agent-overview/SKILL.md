---
name: agent-overview
description: "Route to the right agent-* skill and apply the core rules for any AI agent. Use when starting to design, build, host or harden an agent, or when unsure which agent skill applies."
user-invocable: true
---

# Building an AI Agent: Where to Start

An AI agent is a model that calls tools in a loop. Find the stage you are in, load that one skill, and hold every design to the rules below. A whole build passes through several skills; load them one at a time, never all up front.

## Prerequisites

- For the exact API of any SDK, model API or framework, look up its current documentation with a documentation lookup tool or the vendor's docs site. Never write an API call from memory.
- The guidance is vendor-neutral. Vendor field names appear only in blocks labelled "Vendor notes" with a date; treat those as pointers to what exists, not as a reference.

## Routing

A skill is named `agent-<stage>-<topic>`. The stage word says when to use it.

| Stage | When | Skill | Load it to |
|---|---|---|---|
| `plan` | Before any code | `agent-plan-architecture` | Decide single call, workflow or agent; where the loop comes from; local or remote; one agent or several |
| `build` | While writing the agent | `agent-build-loop` | Write and test the loop: exits, turn cap, errors as results |
| `build` | | `agent-build-tools` | Design tools: descriptions, results, read or write, final answer as a tool call |
| `build` | | `agent-build-context` | Decide what each request carries: system prompt, session state, memory, caching |
| `build` | | `agent-build-approval` | Put a person in front of a write: pending action, resume, expiry |
| `host` | When wiring it to a trigger and a channel | `agent-host-local` | Run it on one person's machine: headless harness, schedule, lock |
| `host` | | `agent-host-remote` | Run it as a service: acknowledge, deduplicate, queue, lease, reply once |
| `harden` | Before others depend on it | `agent-harden-evals` | Measure it: eval cases, graders, traces |
| `harden` | | `agent-harden-guardrails` | Limit it: guardrail layers, hard limits, prompt injection, autonomy levels |

The stages are an order for a first build, not a one-way street. Write ten eval cases during `plan`, and load `agent-harden-guardrails` before giving an agent its first write tool.

## Rules

- **Four questions describe any agent** — what starts it, what can it touch, what does it remember, and who can stop it. Answer all four before building.
- **Control flow decides the name** — if your code fixes the order of steps, it is a workflow. If the model picks the next step after each result, it is an agent. Most problems want a workflow.
- **Start at the plainest design** — try one model call with retrieval and examples first. Add a step, a loop, a framework or a second agent only when the plainer design fails on real examples, and only for a need you can name.
- **The model never runs anything** — it asks for a tool call; your code decides what runs.
- **A prompt is not a security boundary** — every limit that matters is enforced by code, credentials or a person, and still holds when the model has been fooled.
- **Approval is an `if` in code** — a gated write waits for a named person. A prompt line that says "ask first" is not a gate. Posting the run's answer to the thread that asked is the reply, not a gated write.
- **Every loop has caps** — a turn cap, a token budget, a deadline and a kill switch that needs no deploy. Running out is an error, never an invented answer.
- **A failed tool is a result** — send the error back to the model in words it can act on. One result for every tool call.
- **Store everything, send a view** — keep the full transcript and build each request from stored state. If your code waits for an answer, your code stores the question.
- **Assume every event arrives twice** — record its id once, give every write a key that is the same on every attempt, and post each reply once.
- **Measure on your own cases** — evals with the real model prove behaviour; unit tests with a fake model prove only your code.
- **Keep what is yours in files you own** — tools, prompts and eval cases outlive the loop, the framework and the vendor.

## The hard floor

These are never traded for speed or simplicity:

- **Tenant isolation** — the tenant id comes from the verified event, lives in code, and filters every query. No tool takes it from the model.
- **Money, access, personal data and deletion** — every such write waits for a person, at every level of autonomy.
- **Secrets** — a key reaches one command from a secret manager at run time. It is never in a file, a prompt, a log or the model's context.
- **Safe retries** — no write runs twice because of a crash, a retry or a double click.
- **Honest output** — an agent says what it did not check, and never reports a fix it has not verified.

## Reference

**Not covered by these skills.** Research each fresh; do not improvise from a neighbouring skill.

| Topic | Closest skill, for context only |
|---|---|
| Streaming replies to a user | `agent-host-remote` |
| OAuth and per-user token storage for acting as the user | `agent-host-remote` |
| Building an MCP server step by step | `agent-build-tools` |
| Cost monitoring and routing between models | `agent-harden-evals` |
| Rate limits and concurrency toward the model provider | `agent-host-remote` |
| Retention and deletion of personal data in transcripts and memory | `agent-build-context` |

**What is verified.** Quotations and figures attributed to a vendor or author trace to a cited source; items marked UNVERIFIED could not be traced. Code in these skills is unrun sketches: type-check and test it in your project. Numbers labelled as examples or defaults are design choices for you to set.

Primary sources are in [references/reading-list.md](references/reading-list.md).

## Checklist

- [ ] The four questions have a one-line answer each.
- [ ] The design is the plainest one that passes real examples, and each added part names the need it meets.
- [ ] Every write is classified, and every gated write has a code gate.
- [ ] The loop has a turn cap, a token budget, a deadline and a kill switch.
- [ ] Every item of the hard floor holds for this agent, checked one by one.
