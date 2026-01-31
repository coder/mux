import { describe, expect, test } from "bun:test";

import type { ExecStream, Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";

function createEmptyReadable(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

describe("execBuffered", () => {
  test("does not call stdin.close when stdin is unused", async () => {
    let closeCalled = false;
    let abortCalled = false;

    const stdin = {
      close: () => {
        closeCalled = true;
        return new Promise<void>(() => undefined);
      },
      abort: () => {
        abortCalled = true;
        return Promise.resolve();
      },
    } as unknown as WritableStream<Uint8Array>;

    const stream: ExecStream = {
      stdout: createEmptyReadable(),
      stderr: createEmptyReadable(),
      stdin,
      exitCode: Promise.resolve(0),
      duration: Promise.resolve(1),
    };

    const runtime = {
      exec: () => Promise.resolve(stream),
    } as unknown as Runtime;

    const result = await execBuffered(runtime, "true", { cwd: "/", timeout: 1 });

    expect(result.exitCode).toBe(0);
    expect(abortCalled).toBe(true);
    expect(closeCalled).toBe(false);
  });
});
