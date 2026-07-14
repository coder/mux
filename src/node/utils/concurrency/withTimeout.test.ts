import { afterEach, describe, expect, it, vi } from "bun:test";

import { raceWithAbortAndTimeout } from "./withTimeout";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("raceWithAbortAndTimeout", () => {
  it("returns a resolved value and clears the timeout", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const result = await raceWithAbortAndTimeout(Promise.resolve("done"), { timeoutMs: 1000 });

    expect(result).toEqual({ kind: "ok", value: "done" });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("returns timeout when the deadline expires", async () => {
    const result = await raceWithAbortAndTimeout(new Promise<never>(() => undefined), {
      timeoutMs: 1,
    });

    expect(result).toEqual({ kind: "timeout" });
  });

  it("returns aborted when the signal aborts", async () => {
    const controller = new AbortController();
    const resultPromise = raceWithAbortAndTimeout(new Promise<never>(() => undefined), {
      signal: controller.signal,
      timeoutMs: 1000,
    });

    controller.abort();

    expect(await resultPromise).toEqual({ kind: "aborted" });
  });
});
