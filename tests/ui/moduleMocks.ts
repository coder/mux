import { afterAll, mock } from "bun:test";

/**
 * bun test shares mock.module registrations across suites in the same run, so
 * a file-scope stub leaks into every later test file (a leaked closed-Dialog
 * stub renders nothing and empties later suites that mount dialog triggers).
 * Call at file scope with the captured real exports to restore them once the
 * registering suite finishes.
 */
export function restoreModulesAfterSuite(
  entries: Array<[modulePath: string, realExports: Record<string, unknown>]>
): void {
  afterAll(() => {
    for (const [modulePath, exports] of entries) {
      void mock.module(modulePath, () => exports);
    }
  });
}
