// Minimal MCP server used by integration tests.
//
// Intentionally tiny + dependency-free: it speaks JSON-RPC over stdio
// (newline-delimited JSON) and exposes a single screenshot tool.
//
// This lets us test the MCP → AI SDK image transformation without relying on
// launching a real browser in CI.

const readline = require("readline");

/**
 * Write a JSON-RPC message to stdout.
 *
 * NOTE: @ai-sdk/mcp stdio transport uses newline-delimited JSON.
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const SERVER_INFO = { name: "mux-test-screenshot-mcp", version: "0.0.0" };

const TOOLS = [
  {
    name: "take_screenshot",
    description: "Return a deterministic screenshot image payload (base64) for tests.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format",
        },
      },
      additionalProperties: true,
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
        if (toolName !== "take_screenshot") {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          });
          return;
        }

        const format = message.params?.arguments?.format;
        const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

        // Produce a deterministic payload large enough for tests (>1000 chars base64).
        const fillByte = mimeType === "image/jpeg" ? 0x22 : 0x11;
        const data = Buffer.alloc(2048, fillByte).toString("base64");

        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "image", data, mimeType }],
          },
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
