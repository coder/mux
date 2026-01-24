import { GlobalWindow } from "happy-dom";

interface DomGlobalsSnapshot {
  window: typeof globalThis.window;
  document: typeof globalThis.document;
  navigator: typeof globalThis.navigator;
  localStorage: typeof globalThis.localStorage;
  DocumentFragment: unknown;
  Element: unknown;
  HTMLInputElement: unknown;
  HTMLElement: unknown;
  NodeFilter: unknown;
  Node: unknown;
  Image: unknown;
  requestAnimationFrame: typeof globalThis.requestAnimationFrame;
  cancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
  getComputedStyle: typeof globalThis.getComputedStyle;
  ResizeObserver: unknown;
  IntersectionObserver: unknown;
  MutationObserver: unknown;
}

// NOTE: installDom intentionally mutates globalThis.* (window/document/etc) to give UI
// tests a DOM environment.
//
// Some Radix internals decide at module-eval time whether to enable useLayoutEffect based
// on `globalThis.document`. See the bootstrap at the bottom of this module.

export function installDom(): () => void {
  const previous: DomGlobalsSnapshot = {
    window: globalThis.window,
    document: globalThis.document,
    Element: (globalThis as unknown as { Element?: unknown }).Element,
    DocumentFragment: (globalThis as unknown as { DocumentFragment?: unknown }).DocumentFragment,
    navigator: globalThis.navigator,
    HTMLInputElement: (globalThis as unknown as { HTMLInputElement?: unknown }).HTMLInputElement,
    localStorage: globalThis.localStorage,
    NodeFilter: (globalThis as unknown as { NodeFilter?: unknown }).NodeFilter,
    HTMLElement: (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement,
    Node: (globalThis as unknown as { Node?: unknown }).Node,
    Image: (globalThis as unknown as { Image?: unknown }).Image,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver,
    MutationObserver: (globalThis as unknown as { MutationObserver?: unknown }).MutationObserver,
    IntersectionObserver: (globalThis as unknown as { IntersectionObserver?: unknown })
      .IntersectionObserver,
  };

  const domWindow = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
    typeof globalThis;

  globalThis.window = domWindow;
  globalThis.document = domWindow.document;
  globalThis.navigator = domWindow.navigator;
  globalThis.getComputedStyle = domWindow.getComputedStyle.bind(domWindow);
  globalThis.localStorage = domWindow.localStorage;
  (globalThis as unknown as { Element: unknown }).Element = domWindow.Element;
  (globalThis as unknown as { DocumentFragment: unknown }).DocumentFragment =
    domWindow.DocumentFragment;
  (globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement =
    domWindow.HTMLInputElement;
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = domWindow.HTMLElement;
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver =
    domWindow.MutationObserver;
  (globalThis as unknown as { NodeFilter: unknown }).NodeFilter = domWindow.NodeFilter;
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

    (globalThis as unknown as { Element?: unknown }).Element = previous.Element;
    globalThis.window = previous.window;
    (globalThis as unknown as { DocumentFragment?: unknown }).DocumentFragment =
      previous.DocumentFragment;
    globalThis.document = previous.document;
    globalThis.navigator = previous.navigator;
    (globalThis as unknown as { HTMLInputElement?: unknown }).HTMLInputElement =
      previous.HTMLInputElement;
    globalThis.localStorage = previous.localStorage;
    (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement = previous.HTMLElement;
    (globalThis as unknown as { NodeFilter?: unknown }).NodeFilter = previous.NodeFilter;
    (globalThis as unknown as { MutationObserver?: unknown }).MutationObserver =
      previous.MutationObserver;
    (globalThis as unknown as { Node?: unknown }).Node = previous.Node;
    (globalThis as unknown as { Image?: unknown }).Image = previous.Image;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver =
      previous.IntersectionObserver;
    (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      previous.ResizeObserver;
  };
}

/**
 * Bootstrap a baseline Happy DOM document early.
 *
 * Radix's @radix-ui/react-use-layout-effect decides at module evaluation time whether
 * to use React.useLayoutEffect based on `globalThis.document`. In Jest's node
 * environment, `document` starts undefined, which makes Radix fall back to a noop and
 * breaks Portals (Dialogs/Tooltips/etc).
 *
 * We install a baseline DOM once on module import so downstream UI modules see a truthy
 * `document` during evaluation. Individual tests still call installDom() to get an
 * isolated Window per test.
 */
if (typeof globalThis.document === "undefined") {
  installDom();
}
