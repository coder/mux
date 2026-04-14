import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { HydrationStablePane } from "./HydrationStablePane";

let cleanupDom: (() => void) | null = null;
let originalResizeObserver: typeof ResizeObserver | undefined;
const resizeCallbacks = new Map<Element, ResizeObserverCallback[]>();

class ResizeObserverMock {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    resizeCallbacks.set(target, [...(resizeCallbacks.get(target) ?? []), this.callback]);
  }

  unobserve(target: Element) {
    const remainingCallbacks = (resizeCallbacks.get(target) ?? []).filter(
      (callback) => callback !== this.callback
    );
    if (remainingCallbacks.length === 0) {
      resizeCallbacks.delete(target);
      return;
    }
    resizeCallbacks.set(target, remainingCallbacks);
  }

  disconnect() {
    for (const [target, callbacks] of resizeCallbacks) {
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
  const contentRect = {
    x: 0,
    y: 0,
    width: 0,
    height,
    top: 0,
    right: 0,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } satisfies DOMRectReadOnly;
  const entry: ResizeObserverEntry = {
    target,
    contentRect,
    borderBoxSize: [] as unknown as readonly ResizeObserverSize[],
    contentBoxSize: [] as unknown as readonly ResizeObserverSize[],
    devicePixelContentBoxSize: [] as unknown as readonly ResizeObserverSize[],
  };

  for (const callback of resizeCallbacks.get(target) ?? []) {
    callback([entry], {} as ResizeObserver);
  }
}

describe("HydrationStablePane", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    originalResizeObserver = globalThis.ResizeObserver;
    (
      globalThis as unknown as {
        ResizeObserver: typeof ResizeObserver;
      }
    ).ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    resizeCallbacks.clear();
  });

  afterEach(() => {
    cleanup();
    resizeCallbacks.clear();
    if (originalResizeObserver === undefined) {
      delete (globalThis as Partial<typeof globalThis>).ResizeObserver;
    } else {
      (
        globalThis as unknown as {
          ResizeObserver: typeof ResizeObserver;
        }
      ).ResizeObserver = originalResizeObserver;
    }
    cleanupDom?.();
    cleanupDom = null;
    originalResizeObserver = undefined;
  });

  it("holds the last measured height while switching to a hydrating workspace", async () => {
    const view = render(
      <HydrationStablePane
        workspaceId="workspace-a"
        isHydrating={false}
        dataComponent="stable-pane"
      >
        <div>workspace A</div>
      </HydrationStablePane>
    );

    const pane = view.container.querySelector('[data-component="stable-pane"]');
    expect(pane).toBeTruthy();
    if (!pane) {
      throw new Error("Expected pane to exist");
    }

    await waitFor(() => {
      const callbacks = resizeCallbacks.get(pane);
      if (!callbacks || callbacks.length === 0) {
        throw new Error("Resize observer is not attached yet");
      }
    });
    emitResize(pane, 184);

    view.rerender(
      <HydrationStablePane workspaceId="workspace-b" isHydrating={true} dataComponent="stable-pane">
        <div>workspace B</div>
      </HydrationStablePane>
    );

    expect((pane as HTMLDivElement).style.minHeight).toBe("184px");

    view.rerender(
      <HydrationStablePane
        workspaceId="workspace-b"
        isHydrating={false}
        dataComponent="stable-pane"
      >
        <div>workspace B</div>
      </HydrationStablePane>
    );

    expect((pane as HTMLDivElement).style.minHeight).toBe("");
  });
});
