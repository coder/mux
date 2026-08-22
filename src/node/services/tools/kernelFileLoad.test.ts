import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";

import { createKernelFileLoader } from "./kernelFileLoad";

describe("createKernelFileLoader line counting", () => {
  it("does not count a trailing newline as an extra line", async () => {
    // The {lines} summary is model-visible and used directly for exact-count
    // tasks; a conventional newline-terminated file must not report one more
    // line than it contains.
    using tmp = new DisposableTempDir("kernel-load-lines");
    await fs.writeFile(nodePath.join(tmp.path, "terminated.txt"), "line1\nline2\n", "utf8");
    await fs.writeFile(nodePath.join(tmp.path, "unterminated.txt"), "line1\nline2", "utf8");
    await fs.writeFile(nodePath.join(tmp.path, "empty.txt"), "", "utf8");
    await fs.writeFile(nodePath.join(tmp.path, "blank-line.txt"), "line1\n\nline3\n", "utf8");

    const load = createKernelFileLoader({ cwd: tmp.path, runtime: new LocalRuntime(tmp.path) });

    expect((await load({ path: "terminated.txt" })).lines).toBe(2);
    expect((await load({ path: "unterminated.txt" })).lines).toBe(2);
    expect((await load({ path: "empty.txt" })).lines).toBe(0);
    // Interior blank lines still count as records.
    expect((await load({ path: "blank-line.txt" })).lines).toBe(3);
  });
});

describe("createKernelFileLoader byte ceiling", () => {
  it("fails and cancels when the stream exceeds the size the stat reported", async () => {
    // Models /dev/zero (stat size 0, infinite stream) and stat→read growth
    // races without depending on platform device files: the pre-read size
    // check passes, so only a ceiling enforced WHILE consuming the stream
    // bounds host memory. Local readFile ignores the abort signal, so the
    // execution deadline cannot save us either.
    using tmp = new DisposableTempDir("kernel-load-ceiling");
    await fs.writeFile(nodePath.join(tmp.path, "a.txt"), "x", "utf8");

    let cancelled = false;
    const inner = new LocalRuntime(tmp.path);
    const lyingRuntime = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "stat") {
          return async (path: string, signal?: AbortSignal) => ({
            ...(await target.stat(path, signal)),
            size: 0,
          });
        }
        if (prop === "readFile") {
          // 4MB in 64KB chunks — over the 1MB ceiling but finite, so a
          // regression fails this test cleanly instead of hanging it.
          let enqueued = 0;
          return () =>
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (enqueued >= 4 * 1024 * 1024) {
                  controller.close();
                  return;
                }
                enqueued += 64 * 1024;
                controller.enqueue(new Uint8Array(64 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            });
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const load = createKernelFileLoader({ cwd: tmp.path, runtime: lyingRuntime });
    try {
      await load({ path: "a.txt" });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("read exceeded");
    }
    // The ceiling must stop the source early — not consume all 4MB first.
    expect(cancelled).toBe(true);
  });
});

describe("createKernelFileLoader cancellation", () => {
  it("threads the abort signal into runtime.stat and runtime.readFile", async () => {
    // Kernel cancellation must reach the underlying I/O: on RemoteRuntime a
    // read without a signal falls back to the 300s cat timeout, holding the
    // persistent-mount lease long past the execution deadline or a removal.
    using tmp = new DisposableTempDir("kernel-load-signal");
    await fs.writeFile(nodePath.join(tmp.path, "a.txt"), "hello\n", "utf8");

    const inner = new LocalRuntime(tmp.path);
    const seenStatSignals: Array<AbortSignal | undefined> = [];
    const seenReadSignals: Array<AbortSignal | undefined> = [];
    // Recording proxy: forward everything, capture the signals the loader
    // passes to the two I/O entry points.
    const recording = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "stat") {
          return (path: string, signal?: AbortSignal) => {
            seenStatSignals.push(signal);
            return target.stat(path, signal);
          };
        }
        if (prop === "readFile") {
          return (path: string, signal?: AbortSignal) => {
            seenReadSignals.push(signal);
            return target.readFile(path, signal);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const controller = new AbortController();
    const load = createKernelFileLoader({ cwd: tmp.path, runtime: recording });
    await load({ path: "a.txt", abortSignal: controller.signal });

    expect(seenStatSignals).toEqual([controller.signal]);
    expect(seenReadSignals).toEqual([controller.signal]);
  });
});
