import { TextDecoder, TextEncoder } from "util";
import type { MCPTransport, JSONRPCMessage } from "@ai-sdk/mcp";
import type { ExecStream } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";

function findHeaderEnd(buffer: Uint8Array): number {
  for (let i = 0; i < buffer.length - 3; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

/**
 * Minimal stdio transport for MCP servers using JSON-RPC over Content-Length framed messages.
 */
export class MCPStdioTransport implements MCPTransport {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private running = false;
  private readonly exitPromise: Promise<number>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly execStream: ExecStream) {
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
    const payload = JSON.stringify(message);
    const body = this.encoder.encode(payload);
    const header = this.encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
    const framed = concatBuffers(header, body);
    await this.stdinWriter.write(framed);
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
          const chunk = value;
          this.buffer = concatBuffers(this.buffer, chunk);
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
    while (true) {
      const headerEnd = findHeaderEnd(this.buffer);
      if (headerEnd === -1) return; // Need more data

      const headerBytes = this.buffer.slice(0, headerEnd);
      const headerText = this.decoder.decode(headerBytes);
      const contentLengthMatch = headerText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().startsWith("content-length"));

      if (!contentLengthMatch) {
        throw new Error("Content-Length header missing in MCP response");
      }

      const [, lengthStr] = contentLengthMatch.split(":");
      const contentLength = parseInt(lengthStr?.trim() ?? "", 10);
      if (!Number.isFinite(contentLength)) {
        throw new Error("Invalid Content-Length header in MCP response");
      }

      const messageStart = headerEnd + 4; // \r\n\r\n
      if (this.buffer.length < messageStart + contentLength) {
        return; // Wait for more data
      }

      const messageBytes = this.buffer.slice(messageStart, messageStart + contentLength);
      const remaining = this.buffer.slice(messageStart + contentLength);
      this.buffer = remaining;

      const messageText = this.decoder.decode(messageBytes);
      try {
        const message = JSON.parse(messageText) as JSONRPCMessage;
        if (this.onmessage) {
          this.onmessage(message);
        }
      } catch (error) {
        if (this.onerror) {
          this.onerror(error as Error);
        } else {
          log.error("Failed to parse MCP message", { error, messageText });
        }
      }
    }
  }
}
