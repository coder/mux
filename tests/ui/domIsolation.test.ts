import { describe, expect, test } from "bun:test";

import { installDom } from "./dom";

describe("dom isolation", () => {
  test("uninstall re-bootstraps a baseline instead of restoring a poisoned document", () => {
    // Outer scope snapshots the healthy globals so this test leaves the ambient
    // baseline untouched for later files.
    const uninstallOuter = installDom();
    try {
      // Simulate a foreign test file that tore down with document poisoned.
      globalThis.document = undefined as unknown as Document;
      const uninstall = installDom();
      uninstall();

      expect(globalThis.document).toBeDefined();
      expect(globalThis.document.createTextNode("x").textContent).toBe("x");
    } finally {
      uninstallOuter();
    }
  });

  test("react-dnd internals survive re-evaluation in a document-less environment", () => {
    // The eager require in dom.ts must have initialized react-dnd's internal
    // module graph while the DOM was healthy; a fresh top-level re-eval (query
    // suffix) then resolves cached internals instead of crashing in
    // @react-dnd/asap. Without that cache this probe throws.
    const healthyDocument = globalThis.document;
    try {
      globalThis.document = undefined as unknown as Document;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require("react-dnd?dom-isolation-probe=1") as {
        DragPreviewImage?: unknown;
      };
      expect(fresh.DragPreviewImage).toBeDefined();
    } finally {
      globalThis.document = healthyDocument;
    }
  });
});
