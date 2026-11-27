# AGENTS.md

How to design, build, run and harden an AI agent: a model that calls tools in a loop. Read this file first, then load the skill for the step you are on, one skill at a time. A whole build passes through several skills; never read them all up front.

The guidance is vendor-neutral. Skills name concepts such as "model call", "tool call" and "stop reason". Vendor field names appear only in dated "Vendor notes" blocks.

## How to use these skills

1. Find your stage in the route below.
2. Read that skill's `SKILL.md`. Open its `references/` and `assets/` files only when the skill points you there.
3. Follow a skill's route-out when it names a sibling; skills do not repeat each other.

## The route

A skill is named `agent-<stage>-<topic>`. The stage word says when to use it.

| Stage | When | Skill | Read it when you need to |
|---|---|---|---|
| `plan` | Before any code | `agent-plan-architecture` | Decide single call, workflow or agent; own loop, harness, framework or hosted runtime; local or remote; one agent or several; a durable engine or not |
| `build` | While writing the agent | `agent-build-loop` | Write and test the loop: exits, turn cap, errors as results, fake-client tests |
| `build` | | `agent-build-tools` | Design tools: descriptions, results, read or write, final answer as a tool call, MCP server or function |
| `build` | | `agent-build-context` | Decide what each request carries: system prompt, session state, memory, long history, caching |
| `build` | | `agent-build-approval` | Put a human in front of a write: pending action, resume, expiry, the question message |
| `host` | When wiring it to a trigger, a channel and a place to run | `agent-host-local` | Run it on one person's machine: headless harness, schedule, lock, gate in the script |
| `host` | | `agent-host-remote` | Run it as a service: acknowledge, dedupe, queue, lease, post once, durable steps, identity |
| `harden` | Before others depend on it | `agent-harden-evals` | Measure it: eval cases, graders, the eval loop, traces |
| `harden` | | `agent-harden-guardrails` | Limit it: guardrail layers, hard limits, prompt injection, autonomy ladder, launch checklist |

The stages are an order for a first build, not a one-way street. Write ten eval cases during `plan`, and read `agent-harden-guardrails` before giving an agent its first write tool.

## Core principles

These hold for every agent. Each skill expands the ones it owns.

1. **Four questions describe any agent.** What starts it, what can it touch, what does it remember, and who can stop it. Answer all four before building.
2. **Who owns the control flow decides the name.** If your code fixes the order of steps, it is a workflow. If the model picks the next step after each result, it is an agent. Most problems want a workflow.
3. **Start at the plainest design.** Try one model call with retrieval and examples first. Add a step, a loop, a framework or a second agent only when the plainer design fails on real examples, and only for a need you can name.
4. **The model never runs anything.** It asks for a tool call; your code decides what runs. An agent is ordinary backend engineering around one unusual function call.
5. **A prompt is not a security boundary.** Every limit that matters is enforced by code, credentials or a person, and still holds when the model has been fooled.
6. **Approval is an `if` in code.** A gated write waits for a named person, and a sentence in the prompt that says "ask first" is not a gate. Posting the run's answer to the thread that asked is the reply, not a gated write. Which other writes are gated follows the hard floor below and the autonomy ladder in `agent-harden-guardrails`.
7. **Every loop has caps.** A turn cap, a token budget, a deadline and a kill switch that needs no deploy. Running out is an error, never an invented answer.
8. **A failed tool is a result.** Send the error back to the model in words it can act on. One result for every tool call.
9. **Store everything, send a view.** Keep the full transcript; build each request from stored state. If your code waits for an answer, your code stores the question.
10. **Assume every event arrives twice.** Record its id once, give every write a key that is the same on every attempt, and post each reply once.
11. **Measure on your own cases.** Evals with the real model prove behaviour; unit tests with a fake model prove only your code. Run your cases in your own harness before trusting any published score.
12. **Keep what is yours in files you own.** Tools, prompts and eval cases outlive the loop, the framework and the vendor. The loop is cheap to rewrite.

## The hard floor

These are never traded for speed or simplicity, in any skill:

- **Tenant isolation.** The tenant id comes from the verified event, lives in code, and filters every query. No tool takes it from the model.
- **Money, access, personal data and deletion.** Every such write waits for a human, at every level of autonomy.
- **Secrets.** A key reaches one command from a secret manager at run time. It is never in a file, a prompt, a log or the model's context.
- **Safe retries.** No write runs twice because of a crash, a retry or a double click.
- **Honest output.** An agent says what it did not check, and never reports a fix it has not verified.

## Looking up current documentation

SDKs, model APIs and frameworks change faster than these skills. Before writing code against any of them:

- Look up the current documentation with a documentation lookup tool, such as Context7, or the vendor's own docs site. Never write an API call from memory.
- Treat every "Vendor notes" block here as a dated pointer to what exists, not as a reference.
- Do not copy SDK documentation into these skills; it goes stale.

## Reading list

Primary sources behind these skills. Read the original when a skill's summary is not enough.

| Source | Use it for |
|---|---|
| [Anthropic Engineering](https://www.anthropic.com/engineering) | The most complete series on agents. Start with [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), then [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents), [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and the [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) |
| [OpenAI Engineering](https://openai.com/news/engineering/) and [OpenAI agent guides](https://developers.openai.com/api/docs/guides/agents) | [A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf), and the guides on orchestration, guardrails and approvals |
| [Google Agent Development Kit docs](https://adk.dev/) and the Kaggle whitepapers [Introduction to Agents](https://www.kaggle.com/whitepaper-introduction-to-agents), [Agent Quality](https://www.kaggle.com/whitepaper-agent-quality) and [Agent Companion](https://www.kaggle.com/whitepaper-agent-companion) | Google's framing, which splits workflow and agent less sharply than these skills do, and its evaluation of the path as well as the answer |
| [12-factor agents](https://github.com/humanlayer/12-factor-agents) | Owning your prompts, context and control flow |
| [Context engineering lessons from Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | Cache-friendly, append-only context |
| [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) and [Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) | Prompt injection and what to remove |
| [OWASP GenAI Security Project](https://genai.owasp.org/) | The named risks for model and agent applications |
| [monday.com: agents with keys to production](https://engineering.monday.com/how-we-gave-ai-agents-the-keys-to-production-and-still-sleep-at-night) | A production guardrail list |
| [Model Context Protocol](https://modelcontextprotocol.io/) and [A2A](https://a2a-protocol.org/latest/) | The protocols for agent-to-tool and agent-to-agent connections |

## Known gaps

These topics are not covered yet. Research them fresh; do not improvise from a neighbouring skill.

- Streaming replies to a user.
- OAuth and per-user token storage for acting as the user.
- Building an MCP server step by step.
- Cost monitoring and routing between models.
- Rate limits and concurrency control toward the model provider.
- Retention and deletion of personal data in transcripts and memory.

## What is and is not verified

- Every quotation and every figure attributed to a vendor or author in a skill traces to a cited source. Items a skill marks UNVERIFIED could not be traced. Numbers labelled as examples or starting values are placeholders for you to set.
- The code in these skills is sketches. None of it has been run. Type-check and test it in your project before relying on it.
- Defaults labelled "Default" or "recommended default" are design choices, not vendor guidance. Change them with a reason.

## Maintaining these skills

- A skill follows the house skill standard: a name equal to its folder, a description that states what it does and when to use it, and one closer per role.
- Keep the core of each skill vendor-neutral. A vendor's field name belongs in a dated "Vendor notes" block that covers at least two vendors.
- A new skill takes a stage word. Add a stage only when no existing one fits.
- When a skill is added, renamed or removed, update the route table in this file in the same change.
- Keep this file under 150 lines.
