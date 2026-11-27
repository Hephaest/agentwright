# Vendor landscape

The first section is a vendor-neutral model that stays true. Everything after it is **Vendor notes, as of November 2026**: product names, status and traps read from vendor pages on 26 November 2026. Names and terms in this field change every few months. Before relying on any line below, check the vendor's current documentation with your documentation lookup tool.

- [The three layers](#the-three-layers)
- [Who sells which layer](#who-sells-which-layer)
- [Status traps](#status-traps)
- [Hosted runtime data terms](#hosted-runtime-data-terms)
- [Where OpenAI-compatible endpoints break](#where-openai-compatible-endpoints-break)
- [Price per token is not price per task](#price-per-token-is-not-price-per-task)
- [Protocols: MCP and A2A](#protocols-mcp-and-a2a)
- [Frameworks](#frameworks)
- [Durable-execution engines](#durable-execution-engines)

## The three layers

Every model vendor sells the same three layers. Going down the table, the loop moves from your code into the vendor's cloud; that is the only real difference.

| Layer | Who runs the loop | What you send | SKILL.md step 3 option |
| --- | --- | --- | --- |
| 1. Model API | Your code, one model call per turn | A request with the history and tool definitions | Own loop |
| 2. Agent SDK | A library inside your process | Configuration and your tools | Coding-agent harness, or an agent SDK |
| 3. Hosted runtime | The vendor, with tools and a sandbox, for minutes or hours | A task and follow-up events | Hosted runtime |

A vendor-neutral framework is a separate axis, not a fourth layer: it runs in your process on top of any layer-1 API. When you meet a new product name, ask which layer it is in. Layer 2 holds two different things: general loop libraries for tools you write, and a coding agent's harness opened up as a library, which brings file and shell tools, permissions and sessions with it.

## Who sells which layer

| Layer | Anthropic | OpenAI | Google | DeepSeek and open-weight models |
| --- | --- | --- | --- | --- |
| 1. Model API | Messages API | Responses API ("recommended for all new projects"); Chat Completions still supported | Interactions API, stateful by default | DeepSeek: OpenAI-format and Anthropic-format endpoints, plus a stateless Responses API. Self-hosted: vLLM, llama.cpp, Ollama |
| 2. Coding-agent harness as a library or command | Claude Agent SDK ("the same tools, agent loop, and context management that power Claude Code"); `claude -p` headless | Codex SDK, server-side; `codex exec` headless | Antigravity SDK (shape UNVERIFIED); Antigravity CLI `agy` | DeepSeek Harness `dsh`, open source developer preview, "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" |
| 2. General agent SDK | Claude Agent SDK covers this too | Agents SDK `@openai/agents`, version 0.22.0, before 1.0 | ADK (Agent Development Kit), TypeScript `@google/adk`, works with non-Google models | Use a vendor-neutral framework |
| 3. Hosted runtime | Managed Agents, beta: agent, environment, session, events | Agents API, public beta since 10 September 2026: the Codex harness, hosted | Agent Runtime hosts your ADK code; Gemini API managed agents run Google's harness in a Linux sandbox | None found |

Sources: [Anthropic Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), [Anthropic Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), [OpenAI agents guide](https://developers.openai.com/api/docs/guides/agents), [Codex SDK](https://developers.openai.com/codex/codex-sdk), [ADK](https://adk.dev/), [Gemini API agents](https://ai.google.dev/gemini-api/docs/agents), [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Status traps

Tutorials from 2025 point at products that are gone or renamed.

| If a tutorial says | As of November 2026 |
| --- | --- |
| OpenAI Agent Builder or AgentKit visual canvas | Shuts down 30 November 2026; ChatKit stays. Migrate to the Agents SDK ([deprecations](https://developers.openai.com/api/docs/deprecations)) |
| OpenAI Evals platform | Shuts down 30 November 2026; OpenAI names Promptfoo as the replacement. Keep eval cases in your own repository |
| Vertex AI, Vertex AI Agent Engine | Gemini Enterprise Agent Platform; Agent Runtime ([name changes](https://docs.cloud.google.com/gemini-enterprise-agent-platform/vertex-ai-name-changes)) |
| ADK `SequentialAgent`, `ParallelAgent`, `LoopAgent` | Deprecated in favour of ADK 2.0 graph workflows ([ADK 2.0](https://adk.dev/2.0/)) |
| Gemini CLI on a free or Pro plan | Antigravity CLI since 18 June 2026 |
| Anthropic "Building effective agents" product names | The post's banner: "Much of the tooling landscape described in this post has changed since December 2024". Its patterns still apply |

Harness traps that affect the choice of a harness:

- **Pre-approve is not restrict** — in the Claude Agent SDK, `allowedTools` only skips the approval prompt: "Any other tool not listed in allowed_tools is still available to Claude." Use the deny list or a sandbox for a real limit.
- **Login** — Anthropic: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Use an API key.
- **Sandbox default** — `codex exec` runs with a read-only sandbox by default; edits need `--sandbox workspace-write`.

## Hosted runtime data terms

Check these before customer data enters a hosted runtime.

| Runtime | What the vendor states |
| --- | --- |
| Anthropic Managed Agents | "not currently eligible for Zero Data Retention or HIPAA Business Associate Agreement (BAA) coverage", except that a self-hosted sandbox can be ZDR-eligible |
| OpenAI Agents API | US data residency only and no Zero Data Retention, per its overview page (UNVERIFIED in this pass) |
| Google Agent Runtime | VPC Service Controls, customer-managed keys, data residency and HIPAA are listed for Runtime, Sessions and Memory Bank |
| Gemini API managed agents | Outbound network is open by default, restrict it with an allowlist; "A single interaction can trigger multiple reasoning loops, typically consuming 100k to 3M tokens" |

## Where OpenAI-compatible endpoints break

"Compatible" means the same request shape, so the loop is identical and only the base URL, key and model name change. It is a subset, and it fails quietly. DeepSeek's Responses API: "Unsupported parameters are silently ignored and do not cause errors."

| Area | What differs |
| --- | --- |
| Reasoning field | `reasoning_content` in DeepSeek and Kimi, `reasoning_details` in MiniMax, `thinking` in Ollama. DeepSeek returns HTTP 400 when it is not sent back on later requests that carry tools. Always send back the whole assistant message |
| Parallel tool calls | DeepSeek's Responses API ignores the flag; Llama 3 on vLLM has no parallel calls |
| Forcing a tool | DeepSeek's Anthropic-format endpoint returns 400 for `tool_choice` `any` with client tools in thinking mode |
| Prompt caching | DeepSeek ignores `cache_control` and `prompt_cache_key` and caches automatically |
| Server-side state | DeepSeek's Responses API is stateless: no `previous_response_id` |
| Self-hosting | vLLM needs `--enable-auto-tool-choice` and a `--tool-call-parser` matched to the model; a mismatch delivers tool calls as plain text |

Sources: [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode), [DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api), [vLLM tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/). Rerun your cases on every provider before switching.

## Price per token is not price per task

Caching and the number of calls decide the bill, not the sticker price. An agent resends its history every turn, so input tokens repeat. Arithmetic on one assumed task (30 calls, 40,000 input and 500 output tokens each, at one vendor's November 2026 prices): the cache hit rate changed the cost about 9 times, the model tier about 4 times, and peak versus off-peak hours 2 times. A cheap model stays cheap only with a stable prompt start and an append-only history (agent-build-context). Check the vendor's pricing page on the day you budget.

The harness matters too. Epoch AI on SWE-bench Verified: "simply switching the scaffold makes up to an 11% difference for GPT-5 and up to a 15% difference for Kimi K2 Thinking ... The choice of scaffold has the single biggest impact on the overall performance" ([Why benchmarking is hard](https://epoch.ai/gradient-updates/why-benchmarking-is-hard)). A vendor's published score came from its own harness.

## Protocols: MCP and A2A

| Protocol | Connects an agent to | Use it when |
| --- | --- | --- |
| MCP (Model Context Protocol), an open standard | Tools, APIs and data, over stdio for a local server or Streamable HTTP for a remote one | You expose or consume tools; tool design is agent-build-tools |
| A2A (Agent2Agent), stable v1.0 spec, under the Linux Foundation | Another team's agent, which publishes an Agent Card (a JSON file with its skills, endpoint and login rules) and works on tasks that move through states such as working and completed | You call an agent someone else owns, whose tools and memory stay hidden from you |

The A2A site's summary: "MCP connects an agent to tools, APIs, and data. A2A connects it to other agents. Use both" ([a2a-protocol.org](https://a2a-protocol.org/latest/)). If the thing you call is really a function you own, A2A is the wrong tool; use a plain function or MCP.

## Frameworks

What each is comes from its docs; the "avoid when" column is a design judgment. Apply the framework rule in SKILL.md step 3 first.

| Framework | What it is | Avoid when |
| --- | --- | --- |
| Vercel AI SDK `ai` | One TypeScript API across providers. The loop is a stop-condition option or a `ToolLoopAgent`, whose default cap is 20 steps. Version 7 calls the cap helper `isStepCount(n)`; older examples use `stepCountIs(n)` | You need exact control of the message list on every turn |
| Mastra | Agents, workflows, memory, tool suspend and resume, and a dev server with traces | You need one loop and already own your queue and database |
| LangGraph JS | A graph of steps over typed state, saved by a checkpointer after every step, with interrupt and resume. On resume the interrupted node reruns from its top | The flow is simple and never pauses for a human |
| Cloudflare Agents SDK | Each agent is a Durable Object with its own SQLite, woken by events. In-memory variables do not survive eviction | You are not on Cloudflare |
| OpenAI Agents SDK | Agents, handoffs, agents as tools, guardrails, approval pauses with serializable state, sessions, tracing; works with other providers | You want a stable API; it is before 1.0 |
| Google ADK | Agents plus 2.0 graph workflows that mix code steps and model steps; model-agnostic | Your flow is one loop with a few tools |
| Pydantic AI (Python) | Typed agents with dependency injection, validated output, deferred tools for approval, optional Temporal durability | Your stack is TypeScript end to end |

Sources: [AI SDK](https://ai-sdk.dev/), [Mastra](https://mastra.ai), [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [Cloudflare long-running agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents), [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk), [ADK graphs](https://adk.dev/graphs/), [Pydantic AI deferred tools](https://github.com/pydantic/pydantic-ai/blob/main/docs/deferred-tools.md).

## Durable-execution engines

Products that record each step so a restart resumes instead of repeating: Temporal, Inngest, Restate, Trigger.dev, Vercel Workflow, Cloudflare Workflows. Restate's definition: a recorded step means "If your process crashes, it doesn't re-execute all steps, but instead, recovers the recorded results from the journal and resumes exactly where it left off" ([Restate](https://www.restate.dev/blog/resilient-serverless-agents)). Whether you need one is SKILL.md step 6; how to use one is agent-host-remote.
