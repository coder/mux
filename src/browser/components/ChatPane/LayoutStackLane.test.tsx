import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { LayoutStackLane } from "./LayoutStackLane";
import type { LayoutStackItem } from "./layoutStack";

let cleanupDom: (() => void) | null = null;
let originalResizeObserver: typeof ResizeObserver | undefined;
const resizeCallbacks = new Map<Element, ResizeObserverCallback[]>();

class ResizeObserverMock implements ResizeObserver {
  public readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    resizeCallbacks.set(target, [...(resizeCallbacks.get(target) ?? []), this.callback]);
  }

  unobserve(target: Element) {
    const callbacks = (resizeCallbacks.get(target) ?? []).filter(
      (callback) => callback !== this.callback
    );
    if (callbacks.length === 0) {
      resizeCallbacks.delete(target);
      return;
    }
    resizeCallbacks.set(target, callbacks);
  }

  disconnect() {
    for (const [target, callbacks] of resizeCallbacks.entries()) {
      const remainingCallbacks = callbacks.filter((callback) => callback !== this.callback);
      if (remainingCallbacks.length === 0) {
        resizeCallbacks.delete(target);
        continue;
      }
      resizeCallbacks.set(target, remainingCallbacks);
    }
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

function emitResize(target: Element, height: number) {
  const callbacks = resizeCallbacks.get(target) ?? [];
  const contentRect: DOMRectReadOnly = {
    x: 0,
    y: 0,
    width: 0,
    height,
    top: 0,
    right: 0,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  };
  const entry: ResizeObserverEntry = {
    target,
    contentRect,
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
  for (const callback of callbacks) {
    callback([entry], {} as ResizeObserver);
  }
}

function getRenderedStack(container: HTMLElement, dataComponent: string): HTMLDivElement {
  const stack = container.querySelector(`[data-component="${dataComponent}"]`);
  expect(stack).toBeTruthy();
  if (stack?.tagName !== "DIV") {
    throw new Error("Expected stack to exist");
  }
  return stack as HTMLDivElement;
}

function getStackContent(container: HTMLElement, dataComponent: string): HTMLDivElement {
  const content = getRenderedStack(container, dataComponent).firstElementChild;
  expect(content).toBeTruthy();
  if (content?.tagName !== "DIV") {
    throw new Error("Expected stack content to exist");
  }
  return content as HTMLDivElement;
}

async function waitForResizeObservation(target: Element): Promise<void> {
  await waitFor(() => {
    const callbacks = resizeCallbacks.get(target);
    if (!callbacks || callbacks.length === 0) {
      throw new Error("Resize observer is not attached yet");
    }
  });
}

function createTextItem(key: string, text: string): LayoutStackItem {
  return { key, node: <div>{text}</div> };
}

function createHiddenItem(key = "idle-decoration"): LayoutStackItem {
  return { key, node: <span hidden /> };
}

describe("LayoutStackLane", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    originalResizeObserver = globalThis.ResizeObserver;
    resizeCallbacks.clear();
    (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    resizeCallbacks.clear();
    if (originalResizeObserver === undefined) {
      delete (globalThis as Partial<typeof globalThis>).ResizeObserver;
    } else {
      (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
        originalResizeObserver;
    }
    cleanupDom?.();
    cleanupDom = null;
    originalResizeObserver = undefined;
  });

  // --- Height reservation (shared between tail + decoration use) ---

  it("holds the last measured height while switching to a hydrating workspace", async () => {
    const view = render(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="end"
        dataComponent="stable-stack"
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );

    const content = getStackContent(view.container, "stable-stack");
    await waitForResizeObservation(content);
    emitResize(content, 184);

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-b"
        isHydrating={true}
        align="end"
        dataComponent="stable-stack"
        items={[]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, "stable-stack").style.minHeight).toBe("184px");
    });

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-b"
        isHydrating={false}
        align="end"
        dataComponent="stable-stack"
        items={[createTextItem("workspace-b", "workspace B")]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, "stable-stack").style.minHeight).toBe("");
    });
  });

  it("ignores zero-height observations from non-rendering items during hydration", async () => {
    const view = render(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="end"
        dataComponent="stable-stack"
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );

    const initialContent = getStackContent(view.container, "stable-stack");
    await waitForResizeObservation(initialContent);
    emitResize(initialContent, 184);

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-b"
        isHydrating={true}
        align="end"
        dataComponent="stable-stack"
        items={[createHiddenItem()]}
      />
    );

    const hydratingContent = getStackContent(view.container, "stable-stack");
    await waitForResizeObservation(hydratingContent);
    emitResize(hydratingContent, 0);

    await waitFor(() => {
      expect(getRenderedStack(view.container, "stable-stack").style.minHeight).toBe("184px");
    });

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-b"
        isHydrating={false}
        align="end"
        dataComponent="stable-stack"
        items={[createHiddenItem()]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, "stable-stack").style.minHeight).toBe("");
    });

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-c"
        isHydrating={true}
        align="end"
        dataComponent="stable-stack"
        items={[createHiddenItem()]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, "stable-stack").style.minHeight).toBe("");
    });
  });

  it("clears settled empty-lane measurements from both the workspace cache and fallback", async () => {
    const view = render(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="end"
        dataComponent="stable-stack"
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );

    const initialContent = getStackContent(view.container, "stable-stack");
    await waitForResizeObservation(initialContent);
    emitResize(initialContent, 184);

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="end"
        dataComponent="stable-stack"
        items={[createHiddenItem()]}
      />
    );

    const settledEmptyContent = getStackContent(view.container, "stable-stack");
    await waitForResizeObservation(settledEmptyContent);
    emitResize(settledEmptyContent, 0);

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={true}
        align="end"
        dataComponent="stable-stack"
        items={[createHiddenItem()]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, "stable-stack").style.minHeight).toBe("");
    });

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-b"
        isHydrating={true}
        align="end"
        dataComponent="stable-stack"
        items={[createHiddenItem()]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, "stable-stack").style.minHeight).toBe("");
    });
  });

  it("renders alignment and overflow-anchor modifiers correctly", () => {
    const view = render(
      <div>
        <LayoutStackLane
          workspaceId="workspace-a"
          isHydrating={false}
          align="end"
          dataComponent="decoration-lane"
          items={[createTextItem("workspace-a", "workspace A")]}
        />
        <div data-component="ChatInputSection">Input</div>
      </div>
    );

    const decoration = getRenderedStack(view.container, "decoration-lane");
    expect(decoration.className).toContain("justify-end");
    expect(decoration.style.overflowAnchor).toBe("");

    const tail = render(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="start"
        overflowAnchor="none"
        dataComponent="tail-lane"
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );
    const tailStack = getRenderedStack(tail.container, "tail-lane");
    expect(tailStack.className).toContain("justify-start");
    expect(tailStack.style.overflowAnchor).toBe("none");
  });

  // --- Stick-to-bottom signal (tail-lane use) ---

  it("fires onStickToBottom when a mounted item changes from hidden to visible", () => {
    const hiddenRetryItem: LayoutStackItem = {
      key: "retry-barrier",
      layoutKey: "retry-barrier:hidden",
      node: null,
    };
    const visibleRetryItem: LayoutStackItem = {
      key: "retry-barrier",
      layoutKey: "retry-barrier:visible",
      node: <div>Retry</div>,
    };
    let pinCount = 0;
    const onStickToBottom = () => {
      pinCount += 1;
    };

    const view = render(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="start"
        overflowAnchor="none"
        onStickToBottom={onStickToBottom}
        dataComponent="tail-lane"
        items={[hiddenRetryItem]}
      />
    );
    const initialPinCount = pinCount;

    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="start"
        overflowAnchor="none"
        onStickToBottom={onStickToBottom}
        dataComponent="tail-lane"
        items={[visibleRetryItem]}
      />
    );

    expect(pinCount).toBeGreaterThan(initialPinCount);
  });

  it("fires onStickToBottom when visible content changes height after mount", async () => {
    let pinCount = 0;
    const onStickToBottom = () => {
      pinCount += 1;
    };

    const view = render(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="start"
        overflowAnchor="none"
        onStickToBottom={onStickToBottom}
        dataComponent="tail-lane"
        items={[{ key: "streaming-barrier", node: <div>Streaming</div> }]}
      />
    );

    const content = getStackContent(view.container, "tail-lane");
    await waitForResizeObservation(content);
    emitResize(content, 40);
    const pinsBeforeHeightChange = pinCount;

    emitResize(content, 88);

    expect(pinCount).toBeGreaterThan(pinsBeforeHeightChange);
  });

  it("fires onStickToBottom when the first measurement is newly visible content", async () => {
    const hiddenStreamingItem: LayoutStackItem = {
      key: "streaming-barrier",
      node: null,
    };
    const visibleStreamingItem: LayoutStackItem = {
      key: "streaming-barrier",
      node: <div>Compacting...</div>,
    };
    let pinCount = 0;
    const onStickToBottom = () => {
      pinCount += 1;
    };

    const view = render(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="start"
        overflowAnchor="none"
        onStickToBottom={onStickToBottom}
        dataComponent="tail-lane"
        items={[hiddenStreamingItem]}
      />
    );

    const content = getStackContent(view.container, "tail-lane");
    await waitForResizeObservation(content);
    const pinsBeforeVisibleMeasurement = pinCount;

    // Active compaction can mount the lane item before its inner barrier renders
    // non-zero height. If the browser's first ResizeObserver delivery is already
    // visible, that first non-zero measurement still needs to repin the transcript.
    view.rerender(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="start"
        overflowAnchor="none"
        onStickToBottom={onStickToBottom}
        dataComponent="tail-lane"
        items={[visibleStreamingItem]}
      />
    );
    emitResize(content, 40);

    expect(pinCount).toBeGreaterThan(pinsBeforeVisibleMeasurement);
  });

  it("does not fire onStickToBottom when the callback is omitted (pure decoration lane)", async () => {
    const view = render(
      <LayoutStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        align="end"
        dataComponent="decoration-lane"
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );

    // Nothing to assert on pin counts — just verifying the component mounts and
    // resize events don't crash without a callback provided.
    const content = getStackContent(view.container, "decoration-lane");
    await waitForResizeObservation(content);
    emitResize(content, 120);
  });
});
