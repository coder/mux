/**
 * Jest setup for jsdom-based browser UI tests.
 *
 * These tests mount the full app, which schedules a bunch of background React
 * updates (Radix tooltips/selects, async effects like branch loading, etc.).
 * In jsdom this can produce extremely noisy act(...) warnings that drown out
 * real failures.
 */

import { EventEmitter } from "events";

const originalConsoleError = console.error.bind(console);
const originalDefaultMaxListeners = EventEmitter.defaultMaxListeners;
const originalConsoleLog = console.log.bind(console);

const shouldSuppressActWarning = (args: unknown[]) => {
  return args.some(
    (arg) => typeof arg === "string" && arg.toLowerCase().includes("not wrapped in act")
  );
};

beforeAll(() => {
  // The full app creates a bunch of subscriptions on a single EventEmitter
  // (ProviderService configChanged). That's OK for these tests, but Node warns
  // once the default (10) listener limit is exceeded.
  EventEmitter.defaultMaxListeners = 50;
  jest.spyOn(console, "error").mockImplementation((...args) => {
    if (shouldSuppressActWarning(args)) {
      return;
    }
    originalConsoleError(...args);
  });

  // Keep the test output focused; individual tests can temporarily unmock if
  // they need to assert on logs.
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  EventEmitter.defaultMaxListeners = originalDefaultMaxListeners;
  (console.error as jest.Mock).mockRestore();
  (console.log as jest.Mock).mockRestore();
  (console.warn as jest.Mock).mockRestore();

  // Ensure captured originals don't get tree-shaken / flagged as unused in some tooling.
  void originalConsoleLog;
});
