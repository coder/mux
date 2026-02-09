import { TextDecoder, TextEncoder } from "util";
import type { MCPTransport, JSONRPCMessage } from "@ai-sdk/mcp";
import type { ExecStream } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";

/**
 * Minimal stdio transport for MCP servers using newline-delimited JSON (NDJSON).
 * Each message is a single line of JSON followed by \n.
 * This matches the protocol used by @ai-sdk/mcp's StdioMCPTransport.
 */
export class MCPStdioTransport implements MCPTransport {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private running = false;
  private readonly exitPromise: Promise<number>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(execStream: ExecStream) {
    this.stdoutReader = execStream.stdout.getReader();
    this.stdinWriter = execStream.stdin.getWriter();
    this.exitPromise = execStream.exitCode;
    // Observe process exit to trigger close event
    void this.exitPromise.then(() => {
      if (this.onclose) this.onclose();
    });
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    void this.readLoop();
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // NDJSON: serialize as JSON followed by newline
    const line = JSON.stringify(message) + "\n";
    const bytes = this.encoder.encode(line);
    await this.stdinWriter.write(bytes);
  }

  async close(): Promise<void> {
    try {
      await this.stdinWriter.close();
    } catch (error) {
      log.debug("Failed to close MCP stdin writer", { error });
    }
    try {
      await this.stdoutReader.cancel();
    } catch (error) {
      log.debug("Failed to cancel MCP stdout reader", { error });
    }
  }

  private async readLoop(): Promise<void> {
    try {
      while (true) {
        const { value, done } = await this.stdoutReader.read();
        if (done) break;
        if (value) {
          this.buffer += this.decoder.decode(value, { stream: true });
          this.processBuffer();
        }
      }
    } catch (error) {
      if (this.onerror) {
        this.onerror(error as Error);
      } else {
        log.error("MCP stdio transport read error", { error });
      }
    } finally {
      if (this.onclose) this.onclose();
    }
  }

  private processBuffer(): void {
    // Process complete lines (NDJSON format)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim().length === 0) continue; // Skip empty lines

      try {
        const message = JSON.parse(line) as JSONRPCMessage;
        if (this.onmessage) {
          this.onmessage(message);
        }
      } catch (error) {
        if (this.onerror) {
          this.onerror(error as Error);
        } else {
          log.error("Failed to parse MCP message", { error, line });
        }
      }
    }
  }
}
