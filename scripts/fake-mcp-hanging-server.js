// Fake MCP server for manual QA testing of hang/interrupt/timeout behavior.
//
// Exposes two tools:
//   - sleep_forever: never responds (simulates a stuck MCP call)
//   - ping: returns "pong" (verifies server is alive)
//
// Usage: Add to Settings → MCP with command:
//   node ./scripts/fake-mcp-hanging-server.js

const readline = require("readline");

/**
 * Write a JSON-RPC message to stdout.
 *
 * NOTE: MCP stdio transport uses newline-delimited JSON.
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const SERVER_INFO = { name: "mux-fake-hanging-mcp", version: "0.0.0" };

const TOOLS = [
  {
    name: "sleep_forever",
    description:
      "Intentionally never responds. Use to test hang/interrupt/timeout behavior.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "ping",
    description: "Returns pong. Use to verify server connectivity.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message?.jsonrpc !== "2.0") return;

  // Notifications have no id; ignore.
  if (message.id === undefined) {
    return;
  }

  const id = message.id;

  try {
    switch (message.method) {
      case "initialize": {
        const protocolVersion = message.params?.protocolVersion ?? "2024-11-05";
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
        return;
      }

      case "tools/list": {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }

      case "tools/call": {
        const toolName = message.params?.name;

        if (toolName === "sleep_forever") {
          // Intentionally never responds — simulates a wedged MCP server.
          return;
        }

        if (toolName === "ping") {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: "pong" }],
            },
          });
          return;
        }

        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        });
        return;
      }

      default: {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
        return;
      }
    }
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

rl.on("close", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  rl.close();
});

process.on("SIGINT", () => {
  rl.close();
});
