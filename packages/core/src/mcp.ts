// A stateless MCP server over streamable HTTP, JSON responses only.
//
// Implements what a tools-only server needs: initialize, notifications, ping, tools/list and
// tools/call. No sessions and no SSE, so each POST gets one JSON body (the transport answers GET
// with 405). Request-independent JSON (the tool list, server info) is serialized once, when the
// handler is built.

// Versions we answer to; a client asking for another gets the newest of these (the spec's rule).
export const PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

export type Content = Record<string, any>;
/** (tool name, arguments) -> [content blocks, isError]. Throw UnknownTool for a tool not served. */
export type ToolCall = (name: string, args: Record<string, any>) => Promise<[Content[], boolean]>;

export class UnknownTool extends Error {
  name = "UnknownTool";
}

export class McpHandler {
  private call: ToolCall;
  private toolsJson: string;
  private initRest: string;

  constructor(name: string, version: string, tools: unknown[], call: ToolCall, instructions?: string) {
    this.call = call;
    this.toolsJson = JSON.stringify({ tools });
    const rest: Record<string, any> = { capabilities: { tools: { listChanged: false } }, serverInfo: { name, version } };
    if (instructions) rest.instructions = instructions;
    this.initRest = JSON.stringify(rest).slice(1); // initialize's result minus protocolVersion
  }

  /** One POSTed JSON-RPC message in; [HTTP status, response body or null for 202] out. */
  async handle(body: string): Promise<[number, string | null]> {
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      return [400, error(null, -32700, "Parse error")];
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return [400, error(null, -32600, "Batches are not supported")];

    const method = msg.method;
    const id = msg.id;
    if (id === undefined || id === null) return [202, null]; // a notification: accept it
    const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {};

    if (method === "tools/call") {
      const name = params.name;
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
      if (typeof name !== "string") return [200, error(id, -32602, "tools/call needs a tool name")];
      let content: Content[];
      let isError: boolean;
      try {
        [content, isError] = await this.call(name, args);
      } catch (e) {
        if (e instanceof UnknownTool) return [200, error(id, -32602, `Unknown tool: ${name}`)];
        // A bug in a tool: tell the model rather than dropping the call.
        const err = e as Error;
        [content, isError] = [[{ type: "text", text: `Tool failed: ${err?.name ?? "Error"}: ${err?.message ?? e}` }], true];
      }
      return [200, result(id, JSON.stringify({ content, isError }))];
    }
    if (method === "tools/list") return [200, result(id, this.toolsJson)];
    if (method === "ping") return [200, result(id, "{}")];
    if (method === "initialize") {
      const asked = params.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
      return [200, result(id, `{"protocolVersion":${JSON.stringify(version)},${this.initRest}`)];
    }
    return [200, error(id, -32601, `Method not found: ${method}`)];
  }
}

function result(id: unknown, resultJson: string): string {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${resultJson}}`;
}

function error(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
