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
