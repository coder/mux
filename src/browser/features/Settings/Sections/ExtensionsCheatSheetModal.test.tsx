import "../../../../../tests/ui/dom";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { installDom } from "../../../../../tests/ui/dom";
import { ExtensionsCheatSheetModal } from "./ExtensionsCheatSheetModal";

describe("ExtensionsCheatSheetModal", () => {
  afterEach(() => {
    cleanup();
  });

  test("uses approval wording for the focused extension capability shortcut", () => {
    const cleanupDom = installDom();
    try {
      const view = render(
        <ThemeProvider forcedTheme="dark">
          <ExtensionsCheatSheetModal isOpen={true} onClose={() => undefined} />
        </ThemeProvider>
      );

      expect(view.getByText("Approve focused extension capabilities")).toBeTruthy();
      expect(view.queryByText("Grant focused extension")).toBeNull();
    } finally {
      cleanupDom();
    }
  });
});
