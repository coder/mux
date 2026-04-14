import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { ChatInputDecorationStack } from "./ChatInputDecorationStack";

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

describe("ChatInputDecorationStack", () => {
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

  it("holds the last measured decoration height while switching to a hydrating workspace", async () => {
    const view = render(
      <ChatInputDecorationStack
        workspaceId="workspace-a"
        isHydrating={false}
        dataComponent="stable-stack"
        items={[<div key="workspace-a">workspace A</div>]}
      />
    );

    const stack = view.container.querySelector('[data-component="stable-stack"]');
    expect(stack).toBeTruthy();
    if (!stack) {
      throw new Error("Expected stack to exist");
    }

    const content = stack.firstElementChild;
    expect(content).toBeTruthy();
    if (!content) {
      throw new Error("Expected content to exist");
    }

    await waitFor(() => {
      const callbacks = resizeCallbacks.get(content);
      if (!callbacks || callbacks.length === 0) {
        throw new Error("Resize observer is not attached yet");
      }
    });
    emitResize(content, 184);

    view.rerender(
      <ChatInputDecorationStack
        workspaceId="workspace-b"
        isHydrating={true}
        dataComponent="stable-stack"
        items={[]}
      />
    );

    const hydratingStack = await waitFor(() => {
      const nextStack = view.container.querySelector('[data-component="stable-stack"]');
      if (!nextStack) {
        throw new Error("Expected hydrating stack to exist");
      }
      expect((nextStack as HTMLDivElement).style.minHeight).toBe("184px");
      return nextStack as HTMLDivElement;
    });

    view.rerender(
      <ChatInputDecorationStack
        workspaceId="workspace-b"
        isHydrating={false}
        dataComponent="stable-stack"
        items={[<div key="workspace-b">workspace B</div>]}
      />
    );

    await waitFor(() => {
      expect(hydratingStack.style.minHeight).toBe("");
    });
  });

  it("reserves only the decoration lane so the input can stay outside the measured wrapper", async () => {
    const view = render(
      <div>
        <ChatInputDecorationStack
          workspaceId="workspace-a"
          isHydrating={false}
          dataComponent="stable-stack"
          items={[<div key="workspace-a">workspace A</div>]}
        />
        <div data-component="ChatInputSection">Input</div>
      </div>
    );

    const stack = view.container.querySelector('[data-component="stable-stack"]');
    expect(stack).toBeTruthy();
    if (!stack) {
      throw new Error("Expected stack to exist");
    }

    const content = stack.firstElementChild;
    expect(content).toBeTruthy();
    if (!content) {
      throw new Error("Expected content to exist");
    }

    await waitFor(() => {
      const callbacks = resizeCallbacks.get(content);
      if (!callbacks || callbacks.length === 0) {
        throw new Error("Resize observer is not attached yet");
      }
    });
    emitResize(content, 120);

    view.rerender(
      <div>
        <ChatInputDecorationStack
          workspaceId="workspace-b"
          isHydrating={true}
          dataComponent="stable-stack"
          items={[]}
        />
        <div data-component="ChatInputSection">Input</div>
      </div>
    );

    const hydratingStack = await waitFor(() => {
      const nextStack = view.container.querySelector('[data-component="stable-stack"]');
      if (!nextStack) {
        throw new Error("Expected hydrating stack to exist");
      }
      expect((nextStack as HTMLDivElement).style.minHeight).toBe("120px");
      return nextStack as HTMLDivElement;
    });

    const inputSection = view.container.querySelector('[data-component="ChatInputSection"]');
    expect(inputSection).toBeTruthy();
    if (!inputSection) {
      throw new Error("Expected input section to exist");
    }

    expect(hydratingStack.className).toContain("justify-end");
    expect(inputSection.previousElementSibling).toBe(hydratingStack);
    expect(hydratingStack.contains(inputSection)).toBe(false);
    expect((inputSection as HTMLDivElement).style.minHeight).toBe("");
  });
});
