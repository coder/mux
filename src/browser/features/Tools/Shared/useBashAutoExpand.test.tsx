import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import { useState } from "react";
import { GlobalWindow } from "happy-dom";

import { useBashAutoExpand } from "./useBashAutoExpand";
import type { ToolStatus } from "./toolUtils";

interface HarnessOptions {
  isLatestStreamingBash: boolean;
  latestStreamingBashId: string | null;
  status: ToolStatus;
  initialExpanded?: boolean;
  initialUserToggled?: boolean;
}

interface HarnessResult {
  expanded: boolean;
  setExpanded: Dispatch<SetStateAction<boolean>>;
  userToggledRef: MutableRefObject<boolean>;
}

function useTestHarness(options: HarnessOptions): HarnessResult {
  const [expanded, setExpanded] = useState(options.initialExpanded ?? false);
  // Stable ref across renders so the harness simulates the parent component.
  const userToggledRef = useState(() => ({
    current: options.initialUserToggled ?? false,
  }))[0] as MutableRefObject<boolean>;

  useBashAutoExpand({
    isLatestStreamingBash: options.isLatestStreamingBash,
    latestStreamingBashId: options.latestStreamingBashId,
    status: options.status,
    setExpanded,
    userToggledRef,
  });

  return { expanded, setExpanded, userToggledRef };
}

let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;

describe("useBashAutoExpand", () => {
  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    const dom = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = dom;
    globalThis.document = dom.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("expands immediately on chat-open when bash is already streaming", () => {
    const { result } = renderHook(() =>
      useTestHarness({
        isLatestStreamingBash: true,
        latestStreamingBashId: "tool-bash-1",
        status: "executing",
      })
    );

    // The chat-open expansion happens in a layout effect, so it must be visible
    // synchronously after the initial render — no setTimeout required.
    expect(result.current.expanded).toBe(true);
  });

  test("delays expand by 300ms for new in-chat bash transitions", async () => {
    const initialProps: HarnessOptions = {
      isLatestStreamingBash: false,
      latestStreamingBashId: null,
      status: "pending",
    };
    const { result, rerender } = renderHook((p: HarnessOptions) => useTestHarness(p), {
      initialProps,
    });

    // Mount with non-streaming state — no auto-expand.
    expect(result.current.expanded).toBe(false);

    // Transition to executing while user is already mounted: row should NOT
    // expand immediately (flash protection).
    rerender({
      isLatestStreamingBash: true,
      latestStreamingBashId: "tool-bash-1",
      status: "executing",
    });
    expect(result.current.expanded).toBe(false);

    // After 300ms, the timer fires and the row expands.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(result.current.expanded).toBe(true);
  });

  test("does not auto-expand when the user has manually toggled", () => {
    const { result } = renderHook(() =>
      useTestHarness({
        isLatestStreamingBash: true,
        latestStreamingBashId: "tool-bash-1",
        status: "executing",
        initialUserToggled: true,
      })
    );

    expect(result.current.expanded).toBe(false);
  });

  test("auto-collapses when a different bash takes over", () => {
    const initialProps: HarnessOptions = {
      isLatestStreamingBash: true,
      latestStreamingBashId: "tool-bash-1",
      status: "executing",
    };
    const { result, rerender } = renderHook((p: HarnessOptions) => useTestHarness(p), {
      initialProps,
    });
    expect(result.current.expanded).toBe(true);

    // A NEW bash starts streaming. From this row's perspective, it stops being
    // the latest streaming bash and a non-null id replaces it.
    rerender({
      isLatestStreamingBash: false,
      latestStreamingBashId: "tool-bash-2",
      status: "executing",
    });

    expect(result.current.expanded).toBe(false);
  });

  test("does NOT auto-collapse when the bash itself completes", () => {
    const initialProps: HarnessOptions = {
      isLatestStreamingBash: true,
      latestStreamingBashId: "tool-bash-1",
      status: "executing",
    };
    const { result, rerender } = renderHook((p: HarnessOptions) => useTestHarness(p), {
      initialProps,
    });
    expect(result.current.expanded).toBe(true);

    // Bash finishes: latestStreamingBashId becomes null because there's no
    // bash currently streaming. The row should keep its expanded state so the
    // user can read the completed output without re-clicking.
    rerender({
      isLatestStreamingBash: false,
      latestStreamingBashId: null,
      status: "completed",
    });

    expect(result.current.expanded).toBe(true);
  });

  test("status pending on mount keeps the row collapsed", () => {
    const { result } = renderHook(() =>
      useTestHarness({
        isLatestStreamingBash: false,
        latestStreamingBashId: null,
        status: "pending",
      })
    );
    expect(result.current.expanded).toBe(false);
  });
});
