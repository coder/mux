/**
 * Tests for useForceCompaction hook
 *
 * Verifies the force compaction behavior when usage exceeds the context limit.
 * The key invariant: force compaction should only trigger ONCE until usage drops below threshold.
 *
 * Bug being tested (now fixed):
 * When compaction completes and continues with a follow-up message, the guard was reset
 * because canInterrupt changed, allowing a second compaction to trigger immediately.
 */

import { describe, test, expect, mock, beforeEach, afterEach, type Mock } from "bun:test";
import { renderHook, act, cleanup } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useForceCompaction, type ForceCompactionParams } from "./useForceCompaction";

describe("useForceCompaction", () => {
  let onTrigger: Mock<() => void>;

  beforeEach(() => {
    // Set up DOM environment for React
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    onTrigger = mock(() => undefined);
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("triggers compaction when shouldForceCompact and canInterrupt are true", () => {
    renderHook(() =>
      useForceCompaction({
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      })
    );

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test("does not trigger when shouldForceCompact is false", () => {
    renderHook(() =>
      useForceCompaction({
        shouldForceCompact: false,
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      })
    );

    expect(onTrigger).not.toHaveBeenCalled();
  });

  test("does not trigger when canInterrupt is false", () => {
    renderHook(() =>
      useForceCompaction({
        shouldForceCompact: true,
        canInterrupt: false,
        isCompacting: false,
        onTrigger,
      })
    );

    expect(onTrigger).not.toHaveBeenCalled();
  });

  test("does not trigger when isCompacting is true", () => {
    renderHook(() =>
      useForceCompaction({
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: true,
        onTrigger,
      })
    );

    expect(onTrigger).not.toHaveBeenCalled();
  });

  test("does NOT trigger double compaction when continue message starts after compaction", () => {
    // This is the key test for the bug fix!
    //
    // Timeline being tested:
    // 1. Stream running, usage high: shouldForceCompact=true → compaction triggers
    // 2. Compaction runs, completes: canInterrupt becomes false briefly
    // 3. Continue message starts: canInterrupt=true again, isCompacting=false
    // 4. BUG (before fix): second compaction would trigger because guard was reset
    // 5. FIX: guard stays set until shouldForceCompact becomes false

    // Phase 1: Initial streaming state exceeding threshold
    const { rerender } = renderHook((props: ForceCompactionParams) => useForceCompaction(props), {
      initialProps: {
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      },
    });

    // First compaction should trigger
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Phase 2: Compaction completes, stream ends briefly
    act(() => {
      rerender({
        shouldForceCompact: true, // Usage still high (compaction summary not yet reflected)
        canInterrupt: false, // Stream ended
        isCompacting: false,
        onTrigger,
      });
    });

    // Still only 1 call (canInterrupt is false)
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Phase 3: Continue message stream starts - THIS IS WHERE THE BUG WOULD OCCUR
    act(() => {
      rerender({
        shouldForceCompact: true, // Usage still high - would trigger second compaction without fix
        canInterrupt: true, // New stream started
        isCompacting: false,
        onTrigger,
      });
    });

    // Key assertion: still only 1 call, NOT 2!
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test("allows new compaction after usage drops below threshold", () => {
    // Phase 1: First compaction triggers
    const { rerender } = renderHook((props: ForceCompactionParams) => useForceCompaction(props), {
      initialProps: {
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      },
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Phase 2: Compaction succeeds, usage drops below threshold
    act(() => {
      rerender({
        shouldForceCompact: false, // Usage dropped!
        canInterrupt: false,
        isCompacting: false,
        onTrigger,
      });
    });

    // Still only 1 call
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Phase 3: Much later, usage builds up again and exceeds threshold
    act(() => {
      rerender({
        shouldForceCompact: true, // Usage exceeded again
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      });
    });

    // New compaction should be allowed since usage dropped and rose again
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  test("does not re-trigger on prop changes while guard is active", () => {
    // Ensure multiple re-renders with same conditions don't trigger multiple times
    const { rerender } = renderHook((props: ForceCompactionParams) => useForceCompaction(props), {
      initialProps: {
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      },
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Re-render with same props (simulating React re-render)
    act(() => {
      rerender({
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      });
    });

    // Still only 1 call
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Re-render again
    act(() => {
      rerender({
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      });
    });

    // Still only 1 call
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test("maintains guard across rapid prop changes", () => {
    // Simulate rapid prop changes that might occur in React concurrent mode
    const { rerender } = renderHook((props: ForceCompactionParams) => useForceCompaction(props), {
      initialProps: {
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: false,
        onTrigger,
      },
    });

    // First trigger
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // Rapid transitions simulating complex UI updates
    act(() => {
      rerender({
        shouldForceCompact: true,
        canInterrupt: false, // Brief interruption
        isCompacting: false,
        onTrigger,
      });
    });

    act(() => {
      rerender({
        shouldForceCompact: true,
        canInterrupt: true, // Back to interruptible
        isCompacting: true, // Now actually compacting
        onTrigger,
      });
    });

    act(() => {
      rerender({
        shouldForceCompact: true,
        canInterrupt: true,
        isCompacting: false, // Compaction done
        onTrigger,
      });
    });

    // Still only the initial trigger - guard prevented all re-triggers
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});
