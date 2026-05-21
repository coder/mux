import { createRequire } from "node:module";

// Shared test utilities for browser tests

const requireForTest = createRequire(import.meta.url);

/**
 * Load a test module without busting Bun's cache.
 *
 * Use this when a suite only needs mock.module registrations to be active before
 * the first load, but the module's normal specifier resolution must stay intact.
 */
export function requireTestModule<T>(modulePath: string): T {
  return requireForTest(modulePath) as T;
}

type TestWindowEventMethod = "addEventListener" | "removeEventListener" | "dispatchEvent";

export type TestWindowWithApi = Window & typeof globalThis & { api?: unknown };

interface InstallTestWindowOptions {
  api?: unknown;
  ensureEventTargetMethods?: boolean;
}

interface InstalledTestWindow {
  window: TestWindowWithApi;
  restore: () => void;
}

const TEST_WINDOW_EVENT_METHODS: Record<TestWindowEventMethod, EventTarget[TestWindowEventMethod]> =
  {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };

export function installTestWindow(options: InstallTestWindowOptions = {}): InstalledTestWindow {
  const existingWindow = globalThis.window as TestWindowWithApi | undefined;
  const targetWindow = existingWindow ?? (Object.create(null) as TestWindowWithApi);
  const createdWindow = existingWindow == null;
  const previousApiDescriptor = Object.getOwnPropertyDescriptor(targetWindow, "api");
  const previousEventMethodDescriptors = new Map<
    TestWindowEventMethod,
    PropertyDescriptor | undefined
  >();

  if (createdWindow) {
    globalThis.window = targetWindow;
  }

  if ("api" in options) {
    Object.defineProperty(targetWindow, "api", {
      configurable: true,
      value: options.api,
    });
  }

  if (options.ensureEventTargetMethods) {
    for (const [method, replacement] of Object.entries(TEST_WINDOW_EVENT_METHODS) as Array<
      [TestWindowEventMethod, EventTarget[TestWindowEventMethod]]
    >) {
      if (typeof targetWindow[method] === "function") {
        continue;
      }

      previousEventMethodDescriptors.set(
        method,
        Object.getOwnPropertyDescriptor(targetWindow, method)
      );
      Object.defineProperty(targetWindow, method, { configurable: true, value: replacement });
    }
  }

  let restored = false;
  return {
    window: targetWindow,
    restore() {
      if (restored) {
        return;
      }
      restored = true;

      if (previousApiDescriptor) {
        Object.defineProperty(targetWindow, "api", previousApiDescriptor);
      } else {
        delete targetWindow.api;
      }

      for (const [method, descriptor] of previousEventMethodDescriptors) {
        if (descriptor) {
          Object.defineProperty(targetWindow, method, descriptor);
        } else {
          delete (targetWindow as Partial<Record<TestWindowEventMethod, unknown>>)[method];
        }
      }

      if (createdWindow && globalThis.window === targetWindow) {
        delete (globalThis as { window?: unknown }).window;
      }
    },
  };
}

export function installTestNavigator(navigator: Navigator): () => void {
  const previousNavigator = globalThis.navigator;
  globalThis.navigator = navigator;

  return () => {
    if (globalThis.navigator !== navigator) {
      return;
    }

    if (previousNavigator) {
      globalThis.navigator = previousNavigator;
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  };
}

/**
 * Helper type for recursive partial mocks.
 * Allows partial mocking of nested objects and async functions.
 */
export type RecursivePartial<T> = {
  [P in keyof T]?: T[P] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>> | R
    : T[P] extends object
      ? RecursivePartial<T[P]>
      : T[P];
};
