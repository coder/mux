import { describe, expect, test } from "bun:test";

import { installDom } from "./dom";

// Cross-file isolation invariants for the shared DOM harness. Some test files
// tear down with `globalThis.document = undefined`; these tests pin that the
// harness never propagates that state to the next file's module evaluation.
describe("dom harness file-boundary isolation", () => {
  test("uninstall never leaves document undefined once a baseline exists", () => {
    // Simulate a poisoned boundary left by a direct teardown.
    globalThis.document = undefined as unknown as Document;
    globalThis.window = undefined as unknown as Window & typeof globalThis;

    const uninstall = installDom();
    uninstall();

    expect(typeof globalThis.document).not.toBe("undefined");
    expect(typeof globalThis.window).not.toBe("undefined");
  });

  test("react-dnd evaluates safely at a poisoned boundary", () => {
    const savedDocument = globalThis.document;
    globalThis.document = undefined as unknown as Document;
    try {
      // Must not crash even when first evaluated without a document
      // (@react-dnd/asap touches document at module-eval time otherwise).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(() => require("react-dnd")).not.toThrow();
    } finally {
      globalThis.document = savedDocument;
    }
  });
});
