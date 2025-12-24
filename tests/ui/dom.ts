import { GlobalWindow } from "happy-dom";

interface DomGlobalsSnapshot {
  window: typeof globalThis.window;
  document: typeof globalThis.document;
  navigator: typeof globalThis.navigator;
  localStorage: typeof globalThis.localStorage;
  HTMLElement: unknown;
  Node: unknown;
  requestAnimationFrame: typeof globalThis.requestAnimationFrame;
  cancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
  ResizeObserver: unknown;
}

export function installDom(): () => void {
  const previous: DomGlobalsSnapshot = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    localStorage: globalThis.localStorage,
    HTMLElement: (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement,
    Node: (globalThis as unknown as { Node?: unknown }).Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver,
  };

  const domWindow = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
    typeof globalThis;

  globalThis.window = domWindow;
  globalThis.document = domWindow.document;
  globalThis.navigator = domWindow.navigator;
  globalThis.localStorage = domWindow.localStorage;
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = domWindow.HTMLElement;
  (globalThis as unknown as { Node: unknown }).Node = domWindow.Node;

  // happy-dom doesn't always define these on globalThis in node env.
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      return window.setTimeout(() => cb(Date.now()), 0);
    };
  }

  if (!globalThis.cancelAnimationFrame) {
    globalThis.cancelAnimationFrame = (id: number) => {
      window.clearTimeout(id);
    };
  }

  // Some UI code paths rely on ResizeObserver for layout/scroll stabilization.
  if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
    class ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe(_target: Element): void {}
      unobserve(_target: Element): void {}
      disconnect(): void {}
    }

    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserver;
  }

  // matchMedia is used by some components and by Radix.
  if (!domWindow.matchMedia) {
    domWindow.matchMedia = ((_query: string) => {
      return {
        matches: false,
        media: _query,
        onchange: null,
        addListener: () => {
          // deprecated
        },
        removeListener: () => {
          // deprecated
        },
        addEventListener: () => {
          // noop
        },
        removeEventListener: () => {
          // noop
        },
        dispatchEvent: () => false,
      };
    }) as unknown as typeof window.matchMedia;
  }

  return () => {
    domWindow.close();

    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.navigator = previous.navigator;
    globalThis.localStorage = previous.localStorage;
    (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement = previous.HTMLElement;
    (globalThis as unknown as { Node?: unknown }).Node = previous.Node;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      previous.ResizeObserver;
  };
}
