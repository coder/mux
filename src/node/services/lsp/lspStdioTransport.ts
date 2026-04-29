import { TextDecoder, TextEncoder } from "node:util";
import type { ExecStream } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";

export interface LspJsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class LspStdioTransport {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stderrReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
  private readonly exitPromise: Promise<number>;
  private buffer = Buffer.alloc(0);
  private running = false;
  private closed = false;
  private stderrTail = "";
  private sendQueue = Promise.resolve();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: LspJsonRpcMessage) => void;

  constructor(execStream: ExecStream) {
    this.stdoutReader = execStream.stdout.getReader();
    this.stderrReader = execStream.stderr.getReader();
    this.stdinWriter = execStream.stdin.getWriter();
    this.exitPromise = execStream.exitCode;
    void this.exitPromise.then(() => {
      this.closed = true;
      this.onclose?.();
    });
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    void this.readLoop();
    void this.drainStderr();
  }

  async send(message: LspJsonRpcMessage): Promise<void> {
    const body = this.encoder.encode(JSON.stringify(message));
    const header = this.encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
    const frame = new Uint8Array(header.byteLength + body.byteLength);
    frame.set(header);
    frame.set(body, header.byteLength);

    // Serialize framed writes so concurrent requests cannot interleave bytes and
    // corrupt Content-Length boundaries on the shared stdio stream.
    const writePromise = this.sendQueue.then(async () => {
      await this.stdinWriter.write(frame);
    });
    this.sendQueue = writePromise.catch(() => undefined);
    await writePromise;
  }

  getStderrTail(): string {
    return this.stderrTail.trim();
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;

    try {
      await this.stdinWriter.close();
    } catch (error) {
      log.debug("Failed to close LSP stdin writer", { error });
    }

    try {
      await this.stdoutReader.cancel();
    } catch (error) {
      log.debug("Failed to cancel LSP stdout reader", { error });
    }

    try {
      await this.stderrReader.cancel();
    } catch (error) {
      log.debug("Failed to cancel LSP stderr reader", { error });
    }
  }

  private async drainStderr(): Promise<void> {
    try {
      while (true) {
        const { value, done } = await this.stderrReader.read();
        if (done) {
          break;
        }

        if (!value) {
          continue;
        }

        this.stderrTail += this.decoder.decode(value, { stream: true });
        if (this.stderrTail.length > 4096) {
          this.stderrTail = this.stderrTail.slice(-4096);
        }
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private async readLoop(): Promise<void> {
    try {
      while (true) {
        const { value, done } = await this.stdoutReader.read();
        if (done) {
          break;
        }

        if (!value) {
          continue;
        }

        this.buffer = Buffer.concat([this.buffer, Buffer.from(value)]);
        this.processBuffer();
      }
    } catch (error) {
      this.handleError(error);
    } finally {
      this.closed = true;
      this.onclose?.();
    }
  }

  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = this.parseContentLength(headerText);
      if (contentLength == null) {
        this.handleError(new Error(`Invalid LSP header block: ${headerText}`));
        return;
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd);
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        const parsed = JSON.parse(body.toString("utf8")) as LspJsonRpcMessage;
        this.onmessage?.(parsed);
      } catch (error) {
        this.handleError(error);
      }
    }
  }

  private parseContentLength(headerText: string): number | null {
    const headerLines = headerText.split("\r\n");
    const contentLengthLine = headerLines.find((line) => line.toLowerCase().startsWith("content-length:"));
    if (!contentLengthLine) {
      return null;
    }

    const rawLength = contentLengthLine.split(":")[1]?.trim();
    const parsedLength = rawLength ? Number.parseInt(rawLength, 10) : Number.NaN;
    return Number.isFinite(parsedLength) ? parsedLength : null;
  }

  private handleError(error: unknown): void {
    const typedError = error instanceof Error ? error : new Error(String(error));
    if (this.onerror) {
      this.onerror(typedError);
      return;
    }
    log.error("LSP stdio transport error", { error: typedError });
  }
}
