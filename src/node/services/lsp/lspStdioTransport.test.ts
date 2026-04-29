import { describe, expect, test } from "bun:test";
import type { ExecStream } from "@/node/runtime/Runtime";
import { LspStdioTransport } from "./lspStdioTransport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createReadable(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function createExecStream(options: {
  stdoutChunks: string[];
  stderrChunks?: string[];
  writes?: string[];
  exitCode?: Promise<number>;
  stdin?: WritableStream<Uint8Array>;
}): ExecStream {
  return {
    stdout: createReadable(options.stdoutChunks),
    stderr: createReadable(options.stderrChunks ?? []),
    stdin:
      options.stdin ??
      new WritableStream<Uint8Array>({
        write(chunk) {
          options.writes?.push(decoder.decode(chunk));
        },
      }),
    exitCode: options.exitCode ?? Promise.resolve(0),
    duration: Promise.resolve(0),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("LspStdioTransport", () => {
  test("parses Content-Length framed messages", async () => {
    const writes: string[] = [];
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    const framed = `Content-Length: ${message.length}\r\n\r\n${message}`;
    const transport = new LspStdioTransport(
      createExecStream({
        stdoutChunks: [framed],
        stderrChunks: ["warning from server"],
        writes,
        exitCode: new Promise<number>(() => undefined),
      })
    );

    const messages: unknown[] = [];
    transport.onmessage = (parsed) => {
      messages.push(parsed);
    };

    transport.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      },
    ]);
    expect(transport.getStderrTail()).toContain("warning from server");

    await transport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
    });

    expect(writes.join("")).toContain("Content-Length:");
    expect(writes.join("")).toContain("\"method\":\"initialize\"");

    await transport.close();
  });

  test("serializes concurrent writes so framed messages do not interleave", async () => {
    const writes: string[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let writeCount = 0;
    const releaseFirstWrite = createDeferred<void>();
    const stdin = new WritableStream<Uint8Array>({
      async write(chunk) {
        writeCount += 1;
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        writes.push(decoder.decode(chunk));

        if (writeCount === 1) {
          await releaseFirstWrite.promise;
        }

        activeWrites -= 1;
      },
    });
    const transport = new LspStdioTransport(
      createExecStream({
        stdoutChunks: [],
        stdin,
        exitCode: new Promise<number>(() => undefined),
      })
    );

    const firstSend = transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    const secondSend = transport.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialized",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writeCount).toBe(1);

    releaseFirstWrite.resolve();
    await Promise.all([firstSend, secondSend]);

    const expectedFirstBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    const expectedSecondBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialized",
    });

    expect(maxActiveWrites).toBe(1);
    expect(writes).toEqual([
      `Content-Length: ${expectedFirstBody.length}\r\n\r\n${expectedFirstBody}`,
      `Content-Length: ${expectedSecondBody.length}\r\n\r\n${expectedSecondBody}`,
    ]);

    await transport.close();
  });
});
