import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { Result } from "@/common/types/result";
import { useInitialLoadState } from "./useInitialLoadState";

describe("useInitialLoadState", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("captures load errors and clears on retry", async () => {
    let shouldFail = true;
    const load = mock(() => {
      if (shouldFail) {
        return Promise.resolve({ success: false as const, error: "boom" });
      }
      return Promise.resolve({ success: true as const, data: undefined });
    });

    const { result } = renderHook(() => useInitialLoadState({ load }));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBe("boom");

    shouldFail = false;

    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBeNull();
  });

  test("times out slow loads", async () => {
    const load = mock(() => new Promise<Result<void, string | null>>(() => undefined));

    const { result } = renderHook(() =>
      useInitialLoadState({ load, timeoutMs: 5, timeoutMessage: "timed out" })
    );

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBe("timed out");
  });
});
