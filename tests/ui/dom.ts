import { GlobalWindow } from "happy-dom";

interface DomGlobalsSnapshot {
  window: typeof globalThis.window;
  document: typeof globalThis.document;
  navigator: typeof globalThis.navigator;
  localStorage: typeof globalThis.localStorage;
  HTMLElement: unknown;
  Node: unknown;
  Image: unknown;
  requestAnimationFrame: typeof globalThis.requestAnimationFrame;
  cancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
  ResizeObserver: unknown;
  IntersectionObserver: unknown;
}

export function installDom(): () => void {
  const previous: DomGlobalsSnapshot = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    localStorage: globalThis.localStorage,
    HTMLElement: (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement,
    Node: (globalThis as unknown as { Node?: unknown }).Node,
    Image: (globalThis as unknown as { Image?: unknown }).Image,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver,
    IntersectionObserver: (globalThis as unknown as { IntersectionObserver?: unknown })
      .IntersectionObserver,
  };

  const domWindow = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
    typeof globalThis;

  globalThis.window = domWindow;
  globalThis.document = domWindow.document;
  globalThis.navigator = domWindow.navigator;
  globalThis.localStorage = domWindow.localStorage;
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = domWindow.HTMLElement;
  (globalThis as unknown as { Node: unknown }).Node = domWindow.Node;
  // Image is used by react-dnd-html5-backend for drag preview
  (globalThis as unknown as { Image: unknown }).Image = domWindow.Image ?? class MockImage {};
  // DataTransfer is used by drag-drop tests
  if (!(globalThis as unknown as { DataTransfer?: unknown }).DataTransfer) {
    (globalThis as unknown as { DataTransfer: unknown }).DataTransfer =
      domWindow.DataTransfer ?? class MockDataTransfer {};
  }

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

  // Used by ReviewPanel/HunkViewer for lazy visibility tracking.
  if (!(globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver) {
    class IntersectionObserver {
      constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
      observe(_target: Element): void {}
      unobserve(_target: Element): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      IntersectionObserver;
  }

  // React DOM's getCurrentEventPriority reads window.event to determine update priority.
  // In happy-dom, this may be undefined, causing errors. Polyfill with undefined-safe getter.
  if (!("event" in domWindow)) {
    Object.defineProperty(domWindow, "event", {
      get: () => undefined,
      configurable: true,
    });
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
    (globalThis as unknown as { Image?: unknown }).Image = previous.Image;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver =
      previous.IntersectionObserver;
    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      previous.ResizeObserver;
  };
}
