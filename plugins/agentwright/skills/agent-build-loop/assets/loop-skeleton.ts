/**
 * Agent loop skeleton: call the model, run the tools it asks for, send the results back, repeat.
 * This is a sketch. It has not been compiled, tested or run against any model API.
 * Adapt it: write one ModelClient adapter for your SDK, and take field names from that SDK's current docs.
 * Every tool here runs as soon as the model asks for it, so a write tool needs a gate first (see agent-build-approval).
 */

/** What the model sees for one tool: its name, when to use it, and a JSON Schema for its arguments. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One tool call from the model. The adapter reports arguments it could not decode as inputError. */
export type ToolCall =
  | { id: string; name: string; input: unknown }
  | { id: string; name: string; inputError: string };

/** The answer to one tool call, matched to it by id. */
export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

/** One history entry in the vendor's own format. The loop never builds, edits or copies one field by field. */
export type HistoryEntry = unknown;

/** A model reply reduced to what the loop branches on, plus the untouched vendor message. */
export interface ModelReply {
  /** final: the model answered. toolCalls: run them and call again. stopped: any other stop reason. */
  outcome: "final" | "toolCalls" | "stopped";
  /** The vendor's own stop reason, kept for errors and logs. */
  stopReason: string;
  text: string;
  toolCalls: readonly ToolCall[];
  /** The whole reply exactly as the vendor returned it, including any reasoning fields. */
  message: HistoryEntry;
}

/** The only vendor-specific code: one adapter per SDK, injected so tests can pass a fake. */
export interface ModelClient {
  userMessage(text: string): HistoryEntry;
  call(request: {
    system: string;
    tools: readonly ToolDefinition[];
    history: readonly HistoryEntry[];
  }): Promise<ModelReply>;
  /** Formats results the vendor's way: one message holding all of them, or one message per call. */
  toolResults(results: readonly ToolResult[]): HistoryEntry[];
}

export interface Tool {
  definition: ToolDefinition;
  execute(input: unknown): Promise<string>;
}

/**
 * Builds a tool whose input is checked before it runs.
 * parse throws a message that says what valid input looks like; the loop sends that message back to the model.
 */
export function defineTool<Args>(
  definition: ToolDefinition,
  parse: (input: unknown) => Args,
  run: (args: Args) => Promise<string>,
): Tool {
  return { definition, execute: async (input) => run(parse(input)) };
}

/** Thrown when the run ends without a final answer. It carries the history for the caller's log or trace. */
export class AgentLoopError extends Error {
  readonly reason: "stopped" | "turnCap";
  readonly history: readonly HistoryEntry[];

  constructor(message: string, reason: "stopped" | "turnCap", history: readonly HistoryEntry[]) {
    super(message);
    this.reason = reason;
    this.history = history;
  }
}

/** Runs one task to a final answer, or throws. maxTurns counts model calls and has no default on purpose. */
export async function runAgent(options: {
  client: ModelClient;
  system: string;
  task: string;
  tools: readonly Tool[];
  maxTurns: number;
}): Promise<string> {
  const { client, system, task, tools, maxTurns } = options;
  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const definitions = tools.map((tool) => tool.definition);
  const history: HistoryEntry[] = [client.userMessage(task)];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const reply = await client.call({ system, tools: definitions, history });
    history.push(reply.message);

    if (reply.outcome === "final") return reply.text;
    if (reply.outcome !== "toolCalls" || reply.toolCalls.length === 0) {
      throw new AgentLoopError(`Model stopped without an answer: ${reply.stopReason}`, "stopped", history);
    }

    // Calls run one at a time, in the order the model sent them.
    const results: ToolResult[] = [];
    for (const call of reply.toolCalls) results.push(await runCall(call, toolsByName));
    history.push(...client.toolResults(results));
  }
  throw new AgentLoopError(`No final answer after ${maxTurns} turns`, "turnCap", history);
}

/** Every call gets exactly one result. A failure becomes an error result the model can read and act on. */
async function runCall(call: ToolCall, toolsByName: ReadonlyMap<string, Tool>): Promise<ToolResult> {
  if ("inputError" in call) {
    return { callId: call.id, content: `Could not read the arguments: ${call.inputError}`, isError: true };
  }
  const tool = toolsByName.get(call.name);
  if (!tool) {
    const available = [...toolsByName.keys()].join(", ");
    return { callId: call.id, content: `Unknown tool ${call.name}. Available tools: ${available}.`, isError: true };
  }
  try {
    return { callId: call.id, content: await tool.execute(call.input), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { callId: call.id, content: message, isError: true };
  }
}

/** Example read-only tool with a run-time input check. The store stands for your own data access. */
export function getTicketTool(store: { get(ticketId: string): Promise<object | undefined> }): Tool {
  return defineTool(
    {
      name: "get_ticket",
      description:
        "Get one support ticket by id. Returns the title, body, reporter and status. " +
        "Use it before you judge a ticket. It does not return comments or attachments.",
      inputSchema: {
        type: "object",
        properties: { ticket_id: { type: "string", description: "A ticket id such as T-1042" } },
        required: ["ticket_id"],
      },
    },
    (input) => {
      const ticketId = (input as { ticket_id?: unknown } | null)?.ticket_id;
      if (typeof ticketId !== "string" || !/^T-\d+$/.test(ticketId)) {
        throw new Error(`ticket_id must be a string like T-1042, got ${JSON.stringify(ticketId)}`);
      }
      return { ticketId };
    },
    async ({ ticketId }) => {
      const ticket = await store.get(ticketId);
      if (!ticket) throw new Error(`No ticket ${ticketId}. Ids look like T-1042.`);
      return JSON.stringify(ticket);
    },
  );
}
