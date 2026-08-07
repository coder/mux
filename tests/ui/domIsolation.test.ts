import { describe, expect, test } from "bun:test";

import { installDom } from "./dom";

// Pins the harness invariant that a poisoned teardown (a test setting
// globalThis.document = undefined) cannot propagate past a file boundary.
describe("dom harness file-boundary isolation", () => {
  test("uninstall never leaves document undefined once a baseline exists", () => {
    globalThis.document = undefined as unknown as Document;
    globalThis.window = undefined as unknown as Window & typeof globalThis;

    const uninstall = installDom();
    uninstall();

    expect(typeof globalThis.document).not.toBe("undefined");
    expect(typeof globalThis.window).not.toBe("undefined");
  });

  test("preloads react-dnd before a poisoned boundary", () => {
    const savedDocument = globalThis.document;
    globalThis.document = undefined as unknown as Document;
    try {
      // Guards the eager preload in dom.ts: without it, this require would be
      // @react-dnd/asap's first evaluation and would crash on document access.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(() => require("react-dnd")).not.toThrow();
    } finally {
      globalThis.document = savedDocument;
    }
  });
});
