---
name: agent-build-tools
description: "Design the tools an agent calls: descriptions, arguments, results, errors, and read or write classification. Use when defining or reviewing a tool, a tool schema or an MCP server. For the approval gate on writes, use agent-build-approval."
user-invocable: false
---

# Designing Agent Tools

A tool is an API whose only user is a model: the model sees the tool's name, description and input schema, never its code, and reads whatever the tool returns as part of its next request. The tool list is the hard upper limit of what an agent can do, so design each tool like an API for a new hire who reads only the docs, takes them literally and cannot ask a question.

## Prerequisites

- For the exact tool-definition fields of an SDK or framework, look up its current documentation with your documentation lookup tool; do not trust memory or the dated vendor notes below.
- Whether the job needs an agent at all, and how many agents, is decided in agent-plan-architecture.

## Definition rules

- **Description** — Write at least three to four sentences: what the tool does, when to use it and when not to, what each argument means, what it returns, what it does not return, and which tool to call next. Anthropic calls detailed descriptions "by far the most important factor in tool performance" ([Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)). Apply OpenAI's "intern test": "Can an intern/human correctly use the function given nothing but what you gave the model?" ([Function calling](https://developers.openai.com/api/docs/guides/function-calling)).
- **Name** — Name the job, in `snake_case` full words, and prefix by system once the agent talks to more than one: `github_list_prs`, `slack_send_message`. A bare `search` is ambiguous the moment a second search exists.
- **One tool per job** — Merge tools that are actions on one object, or that are always called in sequence, into one tool with an `action` enum (Anthropic's example: `create_pr`, `review_pr` and `merge_pr` become one tool). Split a name that hides two jobs, such as one `search` over tickets and code. Prefer a tool that does the whole job, such as finding a free slot and booking it, over low-level tools that make the model page through raw data.
- **Closed choices** — An argument with a fixed set of values is an enum, never free text. A wrong value then cannot be written.
- **Known values** — Never ask the model for a value the code already knows, such as the run's ticket id, the caller's user id or the tenant id. Code attaches it after the call. A value the model copies is a value it can get wrong, and an id the model chooses is an id an injected sentence can change.
- **Arguments** — Name each argument without ambiguity (`user_id`, not `user`), describe its format with an example, mark the required ones, and put bounds such as `minimum` and `maximum` in the schema. Turn on the vendor's strict schema mode where it exists. Neither checks business rules, so the tool still parses its input; agent-build-loop owns where that check runs.

## Result rules

- **Small and meaningful** — Return only the fields the model needs to choose its next step. Anthropic: "Return semantic, stable identifiers (for example, slugs or UUIDs) rather than opaque internal references".
- **Carry the next id** — Each item in a result carries the id the next tool takes, so the model never has to guess or reformat one.
- **Bounded** — Give every list a default limit and a maximum, offer filters or pages, and say what was left out ("3 weaker matches not shown"). Anthropic caps tool responses in its own coding agent at 25,000 tokens by default ([Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)); pick your own cap and enforce it in the tool.
- **Errors written for the model** — Every tool call gets a result, including a failed one. The error text says what was wrong, what valid input looks like and what to try instead. "Error 404" or a stack trace teaches the model nothing. Mark the result as an error where the API has a flag for it.
- **Untrusted content** — A result that contains outside text, such as a ticket body or a web page, can carry instructions an attacker wrote. The model reads it as data only if the guardrails hold; see agent-harden-guardrails.

## Sort every tool into read or write

Decide the kind before writing the tool's code, and record it in the tool registry in code, so the gate reads it from code and never from the prompt.

| Kind | Test | Default handling |
|---|---|---|
| Read | Changes nothing anyone else sees. A bad call wastes one turn. | Run without asking. |
| Write | Changes shared state, spends money, or sends anything outside the system. | Every call passes a gate in code before it runs; see agent-build-approval. |
| Read on a server you do not run | The arguments, and whatever else the model passes, leave your system. | Treat as a write until the server is trusted. OpenAI's advice for MCP tools: "Keep tool approvals on", "including reads and writes" ([Agent Builder safety](https://developers.openai.com/api/docs/guides/agent-builder-safety)). |

To rank writes by risk, OpenAI's practical guide rates each tool low, medium or high by whether it is read-only, whether it can be undone, the permissions it needs and its financial impact.

## The final answer as a tool call

When a run should end with a typed object, give the model a tool whose input schema is the answer, and treat a call to it as the end of the run. Anthropic's rule of thumb: "if you're writing a regex to extract a decision from model output, that decision should have been a tool call" ([How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)). Vendor structured-output features have the same aim: output that matches a schema.

The final-answer tool for the ticket-triage example; the shapes are this skill's own neutral interface, not one vendor's SDK:

```ts
type JsonSchema = Record<string, unknown>;
type ToolDefinition = { name: string; description: string; inputSchema: JsonSchema };
type ToolCall = { id: string; name: string; input: unknown };
type ToolResult = { callId: string; content: string; isError: boolean };

const postTriage: ToolDefinition = {
  name: "post_triage",
  description:
    "Hand in your verdict for this ticket. Call it once, as your last step, after " +
    "checking similar tickets and the code. List anything you did not look at in " +
    "notChecked. Code checks the shape, and a gate stands before the real post.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "evidence", "suggestedOwner", "notChecked"],
    properties: {
      verdict: { type: "string", enum: ["CONFIRMED", "REFUTED", "NEEDS_DIG"] },
      summary: { type: "string", description: "Two or three sentences for the engineer" },
      evidence: { type: "array", items: { type: "string" }, description: "Each item is file:line or a ticket id" },
      suggestedOwner: { type: "string", description: "Team name" },
      notChecked: { type: "array", items: { type: "string" } },
    },
  },
}; // no ticket id in the schema: code attaches it from the run
```

In the loop, a call to `post_triage` is the exit, not a step:

```ts
// inside the loop over this turn's tool calls; results collects this turn's tool results
if (call.name === "post_triage") {
  const parsed = parseVerdict(call.input); // typed Verdict, or a message for the model
  if (parsed.ok) return { verdict: parsed.value, ticketId: run.ticketId }; // the gate runs after this
  results.push({ callId: call.id, content: parsed.message, isError: true }); // model fixes it next turn
}
```

When the final-answer tool is also a write, the run ends with the parsed object and the gate decides whether the real post happens. A model that stops without calling the tool is an exit the loop handles; see agent-build-loop.

## Where a tool lives

Default: start with function tools. Move a tool to an MCP server when a second agent needs it. A side task that needs its own context is a subagent, not a tool; see agent-plan-architecture.

| Way | What it is | Choose it when | Cost |
|---|---|---|---|
| Function tool | A function in your code, described by a schema | Only this agent needs it, like `post_triage` | Nothing extra |
| MCP server | A separate program that offers tools to any agent through the Model Context Protocol, a standard plug between agents and tool servers; local as a child process over standard input and output (stdio), or remote over HTTP at one URL | Several agents need the same system, or a trusted vendor already ships a server | Every connected server adds its definitions to every request, and adds attack surface. OpenAI: "Only use remote MCP servers you trust" ([Connectors and MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)). Import only the tools you need. |
| Command line | A shell tool that runs programs such as `git` or `gh` | A good CLI exists and you can limit what the shell can reach | Needs a sandbox; see agent-host-remote and agent-harden-guardrails |
| Skill | A folder of instructions the agent loads only when a task needs it; its name and description are always loaded, its body on a match, its extra files only if needed | The agent needs to know how to do a task the house way, not to perform an action | Its description must be a trigger ("Use when filling PDF forms"), not a title ("PDF helper"), because the agent picks skills by description |

## Too many tools

Every definition is sent with every request, so each tool costs tokens and attention before any work starts. What the vendors say:

| Vendor | Statement |
|---|---|
| Anthropic | A typical setup of five MCP servers "can consume ~55k tokens in definitions before Claude does any work" ([Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)). |
| Anthropic | "Claude's ability to pick the right tool degrades once you exceed 30–50 available tools." |
| Anthropic | Use tool search at 10 or more tools or over 10k tokens of definitions; plain tool calling fits better below 10 tools. |
| OpenAI | "Aim for fewer than 20 functions available at the start of a turn", called "just a soft suggestion" ([Function calling](https://developers.openai.com/api/docs/guides/function-calling)). |
| OpenAI | "The issue isn't solely the number of tools, but their similarity or overlap": some setups handle more than 15 distinct tools, others struggle with fewer than 10 overlapping ones ([A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)). |

The three fixes, in the order to try them:

| Fix | What it does | Use it when |
|---|---|---|
| Merge | One tool with an `action` enum replaces near-identical tools | Always first |
| Tool search | Definitions load only when the model searches for them; Anthropic says this typically cuts definition tokens by over 85 percent | Many tools, most unused on a given request |
| Code execution | The model writes a script that calls the tools, and only the script's output returns to the model | Results are large, such as thousands of rows of which the model needs a one-line summary |

Default for a small tool set, under about ten tools: send every definition on every request and keep the list fixed for the whole run, which keeps the request prefix stable for caching (see agent-build-context). Add a tool only after the current set has run on real past cases (see agent-harden-evals).

## Examples

**Bad: the model must guess what is searched, what `q` and `n` mean, and what comes back**

```ts
const search: ToolDefinition = {
  name: "search",
  description: "Search tickets.",
  inputSchema: { type: "object", properties: { q: { type: "string" }, n: { type: "number" } } },
};
```

**Good: the same function, with when to use it, what it returns, what it does not, and the next tool**

```ts
const searchSimilarTickets: ToolDefinition = {
  name: "search_similar_tickets",
  description:
    "Find past tickets that look like this one. Use it before giving a verdict, to " +
    "check whether the same problem was seen and fixed before. Returns at most " +
    "'limit' tickets, each with ticket_id, title, status and fix. Does not return " +
    "comments; call get_ticket with a ticket_id for those.",
  inputSchema: {
    type: "object",
    required: ["symptom"],
    properties: {
      symptom: { type: "string", description: "What fails, in plain words, e.g. 'refund total off by one cent'" },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "Default 5" },
    },
  },
};
```

**A result that is small and carries the next id**

```json
{
  "matches": [
    { "ticket_id": "T-1042", "status": "Done", "title": "Total off by one cent after refund", "fix": "Round once, at the end of the sale" },
    { "ticket_id": "T-0987", "status": "Open", "title": "Refund total wrong on split bills" }
  ],
  "more": "3 weaker matches not shown"
}
```

**An error written for the model**

```ts
const result: ToolResult = {
  callId: call.id,
  isError: true,
  content:
    "No ticket T42. Ticket ids look like T-1042: a T, a dash, then digits. " +
    "If you only know the symptom, call search_similar_tickets instead.",
};
```

## Reference

### Vendor notes, as of November 2026

Field names change between API versions. Check the current docs with your documentation lookup tool before relying on any row.

| Concept | Anthropic Messages API | OpenAI Responses API |
|---|---|---|
| Tool definition | `name`, `description`, `input_schema`; name must match `^[a-zA-Z0-9_-]{1,128}$` | Function tool with `name`, `description`, `parameters` |
| Tool call | `tool_use` block with `id`, `name`, `input` | `function_call` item with a `call_id` |
| Tool result | `tool_result` block with `tool_use_id`, `content`, `is_error` | `function_call_output` item with `call_id` and `output`; no error flag, so the error goes in the output text |
| Strict schema | `strict: true` on the tool; structured outputs through `output_config.format` | `strict: true` on the function; every object needs `additionalProperties: false` and every field listed as required, with optional fields typed as nullable |
| Tool search | A tool search tool plus `defer_loading: true` on deferred tools; keep the three to five most-used tools loaded | `tool_search` plus `defer_loading: true` on deferred functions |
| Calling tools from code | Code execution with MCP (engineering post) | Programmatic tool calling (built-in tool) |
| Remote MCP approval | Not covered here | Approval is requested by default before data is shared; `require_approval` is `always` or `never`; `allowed_tools` limits which tools are imported |
| Examples in the definition | `input_examples`, each costing input tokens | "Adding examples may hurt performance for reasoning models" |
| Forcing one tool | Some current models reject forced tool choice; use the default choice plus strict tool use | Not covered here |
| A "why" argument | Ask for a short explanation or evidence, not step-by-step reasoning, which can trigger a refusal | Not covered here |

## Checklist

- [ ] Every tool is recorded in code as read or write, and every write is routed to the gate.
- [ ] Every description has at least three sentences covering when to use, what returns, what it does not return and the next tool.
- [ ] Names are full words, distinct, and prefixed by system when more than one system is in play.
- [ ] Closed choices are enums; no argument asks for a value the code already knows.
- [ ] Every list result has a default limit and a maximum, says what was left out, and each item carries the id the next tool takes.
- [ ] Every failure returns an error result that names the valid input and an alternative.
- [ ] A run that must end with a typed answer ends with a final-answer tool, parsed in code.
- [ ] Each MCP server earns its place: a second agent needs it or a trusted vendor ships it, and only the needed tools are imported.
- [ ] Run each tool directly with one valid input and one invalid input (such as an id in the wrong format); confirm the valid result stays under the size cap and carries the next id, and the invalid one comes back marked as an error that names the valid format.

## Anti-patterns

- **The approval rule in the prompt** — A sentence such as "ask before posting" is not a gate; one injected sentence in a ticket overrides it. The gate is code.
- **Connecting every MCP server "to be safe"** — Each one adds definitions to every request and adds attack surface.
- **Regex over the model's prose** — Parsing a decision out of free text breaks on the first rephrasing; the decision belongs in a tool call.
- **Changing the tool list mid-run for a small tool set** — It breaks the cached request prefix for no gain.
- **Raw dumps as results** — Whole database rows, internal ids and unbounded lists spend the context on noise and push out what matters.
- **Silent failures** — Dropping the result for a failed call, or returning an empty string, leaves the model guessing what happened.
- **A fifth tool before testing four** — Adding tools before the current set has run on real cases hides which tool causes a failure.
