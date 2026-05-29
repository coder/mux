import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { ChatInputDecorationStackLane, TranscriptTailStackLane } from "./LayoutStackLane";
import {
  createChatInputDecorationStackItem,
  createTranscriptTailStackItem,
  type ChatInputDecorationStackItem,
  type TranscriptTailStackItem,
} from "./layoutStack";

let cleanupDom: (() => void) | null = null;
let originalResizeObserver: typeof ResizeObserver | undefined;
const resizeCallbacks = new Map<Element, ResizeObserverCallback[]>();
const COMPOSER_STACK_COMPONENT = "ChatInputDecorationStack";
const TRANSCRIPT_TAIL_STACK_COMPONENT = "TranscriptTailStack";

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

function createTextItem(key: string, text: string): ChatInputDecorationStackItem {
  return createChatInputDecorationStackItem({ key, node: <div>{text}</div> });
}

function createHiddenItem(key = "idle-decoration"): ChatInputDecorationStackItem {
  return createChatInputDecorationStackItem({ key, node: <span hidden /> });
}

function createTranscriptTextItem(key: string, text: string): TranscriptTailStackItem {
  return createTranscriptTailStackItem({ key, node: <div>{text}</div> });
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
      <ChatInputDecorationStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );

    const content = getStackContent(view.container, COMPOSER_STACK_COMPONENT);
    await waitForResizeObservation(content);
    emitResize(content, 184);

    view.rerender(
      <ChatInputDecorationStackLane workspaceId="workspace-b" isHydrating={true} items={[]} />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.minHeight).toBe(
        "184px"
      );
    });

    view.rerender(
      <ChatInputDecorationStackLane
        workspaceId="workspace-b"
        isHydrating={false}
        items={[createTextItem("workspace-b", "workspace B")]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.minHeight).toBe("");
    });
  });

  it("ignores zero-height observations from non-rendering items during hydration", async () => {
    const view = render(
      <ChatInputDecorationStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );

    const initialContent = getStackContent(view.container, COMPOSER_STACK_COMPONENT);
    await waitForResizeObservation(initialContent);
    emitResize(initialContent, 184);

    view.rerender(
      <ChatInputDecorationStackLane
        workspaceId="workspace-b"
        isHydrating={true}
        items={[createHiddenItem()]}
      />
    );

    const hydratingContent = getStackContent(view.container, COMPOSER_STACK_COMPONENT);
    await waitForResizeObservation(hydratingContent);
    emitResize(hydratingContent, 0);

    await waitFor(() => {
      expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.minHeight).toBe(
        "184px"
      );
    });

    view.rerender(
      <ChatInputDecorationStackLane
        workspaceId="workspace-b"
        isHydrating={false}
        items={[createHiddenItem()]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.minHeight).toBe("");
    });

    view.rerender(
      <ChatInputDecorationStackLane
        workspaceId="workspace-c"
        isHydrating={true}
        items={[createHiddenItem()]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.minHeight).toBe("");
    });
  });

  it("attaches ResizeObserver when items mount after an empty null lane", async () => {
    const view = render(
      <ChatInputDecorationStackLane workspaceId="workspace-a" isHydrating={false} items={[]} />
    );

    expect(
      view.container.querySelector(`[data-component="${COMPOSER_STACK_COMPONENT}"]`)
    ).toBeNull();

    view.rerender(
      <ChatInputDecorationStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );

    const mountedContent = getStackContent(view.container, COMPOSER_STACK_COMPONENT);
    await waitForResizeObservation(mountedContent);
    emitResize(mountedContent, 123);

    view.rerender(
      <ChatInputDecorationStackLane workspaceId="workspace-b" isHydrating={true} items={[]} />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.minHeight).toBe(
        "123px"
      );
    });
  });

  it("clears settled empty-lane measurements from both the workspace cache and fallback", async () => {
    const view = render(
      <ChatInputDecorationStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        items={[createTextItem("workspace-a", "workspace A")]}
      />
    );

    const initialContent = getStackContent(view.container, COMPOSER_STACK_COMPONENT);
    await waitForResizeObservation(initialContent);
    emitResize(initialContent, 184);

    view.rerender(
      <ChatInputDecorationStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        items={[createHiddenItem()]}
      />
    );

    const settledEmptyContent = getStackContent(view.container, COMPOSER_STACK_COMPONENT);
    await waitForResizeObservation(settledEmptyContent);
    emitResize(settledEmptyContent, 0);

    view.rerender(
      <ChatInputDecorationStackLane
        workspaceId="workspace-a"
        isHydrating={true}
        items={[createHiddenItem()]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.minHeight).toBe("");
    });

    view.rerender(
      <ChatInputDecorationStackLane
        workspaceId="workspace-b"
        isHydrating={true}
        items={[createHiddenItem()]}
      />
    );

    await waitFor(() => {
      expect(getRenderedStack(view.container, COMPOSER_STACK_COMPONENT).style.minHeight).toBe("");
    });
  });

  it("renders semantic lane policies correctly", () => {
    const view = render(
      <div>
        <ChatInputDecorationStackLane
          workspaceId="workspace-a"
          isHydrating={false}
          items={[createTextItem("workspace-a", "workspace A")]}
        />
        <div data-component="ChatInputSection">Input</div>
      </div>
    );

    const decoration = getRenderedStack(view.container, COMPOSER_STACK_COMPONENT);
    expect(decoration.className).toContain("justify-end");
    expect(decoration.style.overflowAnchor).toBe("");

    const tail = render(
      <TranscriptTailStackLane
        workspaceId="workspace-a"
        isHydrating={false}
        items={[createTranscriptTextItem("workspace-a", "workspace A")]}
      />
    );
    const tailStack = getRenderedStack(tail.container, TRANSCRIPT_TAIL_STACK_COMPONENT);
    expect(tailStack.className).toContain("justify-start");
    expect(tailStack.style.overflowAnchor).toBe("none");
  });
});
