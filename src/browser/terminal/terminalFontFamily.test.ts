import { describe, expect, test } from "bun:test";
import { appendTerminalIconFallback, formatCssFontFamilyList } from "./terminalFontFamily";

describe("terminalFontFamily", () => {
  describe("formatCssFontFamilyList", () => {
    test("quotes names with spaces and preserves generic families", () => {
      expect(formatCssFontFamilyList("Geist Mono, ui-monospace, monospace")).toBe(
        '"Geist Mono", ui-monospace, monospace'
      );
    });

    test("strips redundant quotes for generic families", () => {
      expect(formatCssFontFamilyList('"monospace"')).toBe("monospace");
    });
  });

  describe("appendTerminalIconFallback", () => {
    test("appends Nerd Font Symbols when missing", () => {
      expect(appendTerminalIconFallback("ui-monospace, monospace")).toBe(
        'ui-monospace, monospace, "Nerd Font Symbols"'
      );
    });

    test("does not duplicate Nerd Font Symbols when already present", () => {
      expect(appendTerminalIconFallback('ui-monospace, "Nerd Font Symbols"')).toBe(
        'ui-monospace, "Nerd Font Symbols"'
      );
    });

    test("uses only Nerd Font Symbols when given an empty list", () => {
      expect(appendTerminalIconFallback(" ")).toBe('"Nerd Font Symbols"');
    });
  });
});
