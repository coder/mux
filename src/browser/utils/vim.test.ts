/**
 * Vim Command Integration Tests
 *
 * These tests verify complete Vim command workflows, not isolated utility functions.
 * Each test simulates a sequence of key presses and verifies the final state.
 *
 * Test format:
 * - Initial state: text, cursor position, mode
 * - Execute: sequence of key presses (e.g., ["Escape", "d", "$"])
 * - Assert: final text, cursor position, mode, yank buffer
 *
 * This approach catches integration bugs that unit tests miss:
 * - Cursor positioning across mode transitions
 * - Operator-motion composition
 * - State management between key presses
 *
 * Keep in sync with:
 * - docs/vim-mode.md (user documentation)
 * - src/components/VimTextArea.tsx (React component integration)
 * - src/utils/vim.ts (core Vim logic)
 */

import { describe, expect, test } from "@jest/globals";
import * as vim from "./vim";

/**
 * Execute a sequence of Vim commands and return the final state.
 * Uses the real handleKeyPress() function from vim.ts for complete integration testing.
 */
function executeVimCommands(initial: vim.VimState, keys: string[]): vim.VimState {
  let state = { ...initial };

  for (const key of keys) {
    // Parse key string to extract modifiers
    const ctrl = key.startsWith("Ctrl-");
    const actualKey = ctrl ? key.slice(5) : key;

    const result = vim.handleKeyPress(state, actualKey, { ctrl });

    if (result.handled) {
      // Ignore undo/redo actions in tests (they require browser execCommand)
      if (result.action === "undo" || result.action === "redo") {
        continue;
      }
      state = result.newState;
    }
    // If not handled, browser would handle it (e.g., typing in insert mode)
  }

  return state;
}

describe("Vim Command Integration Tests", () => {
  const initialState: vim.VimState = {
    text: "",
    cursor: 0,
    mode: "insert",
    yankBuffer: "",
    pendingOp: null,
    desiredColumn: null,
  };

  describe("Mode Transitions", () => {
    test("ESC enters normal mode from insert", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 5, mode: "insert" },
        ["Escape"]
      );
      expect(state.mode).toBe("normal");
      expect(state.cursor).toBe(4); // Clamps to last char
    });

    test("i enters insert mode at cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 2, mode: "normal" },
        ["i"]
      );
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(2);
    });

    test("a enters insert mode after cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 2, mode: "normal" },
        ["a"]
      );
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(3);
    });

    test("o opens line below", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\nworld", cursor: 2, mode: "normal" },
        ["o"]
      );
      expect(state.mode).toBe("insert");
      expect(state.text).toBe("hello\n\nworld");
      expect(state.cursor).toBe(6);
    });
  });

  describe("Navigation", () => {
    test("w moves to next word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 0, mode: "normal" },
        ["w"]
      );
      expect(state.cursor).toBe(6);
    });

    test("b moves to previous word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 12, mode: "normal" },
        ["b"]
      );
      expect(state.cursor).toBe(6);
    });

    test("$ moves to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["$"]
      );
      expect(state.cursor).toBe(10); // On last char, not past it
    });

    test("0 moves to start of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 10, mode: "normal" },
        ["0"]
      );
      expect(state.cursor).toBe(0);
    });
  });

  describe("Navigation", () => {
    test("w moves to next word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 0, mode: "normal" },
        ["w"]
      );
      expect(state.cursor).toBe(6);
    });

    test("b moves to previous word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 12, mode: "normal" },
        ["b"]
      );
      expect(state.cursor).toBe(6);
    });

    test("$ moves to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["$"]
      );
      expect(state.cursor).toBe(10); // On last char, not past it
    });

    test("0 moves to start of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 10, mode: "normal" },
        ["0"]
      );
      expect(state.cursor).toBe(0);
    });

    test("w skips punctuation separators like hyphen", () => {
      const initial = {
        ...initialState,
        text: "asd-f asdf asdf",
        cursor: 0,
        mode: "normal" as const,
      };

      const afterFirstW = executeVimCommands(initial, ["w"]);
      expect(afterFirstW.cursor).toBe(4);

      const afterSecondW = executeVimCommands(afterFirstW, ["w"]);
      expect(afterSecondW.cursor).toBe(6);
    });

    test("e moves past punctuation to end of next word", () => {
      const state = executeVimCommands(
        {
          ...initialState,
          text: "asd-f asdf asdf",
          cursor: 3,
          mode: "normal",
        },
        ["e"]
      );

      expect(state.cursor).toBe(4);
    });
  });

  describe("Simple Edits", () => {
    test("x deletes character under cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 1, mode: "normal" },
        ["x"]
      );
      expect(state.text).toBe("hllo");
      expect(state.cursor).toBe(1);
      expect(state.yankBuffer).toBe("e");
    });

    test("p pastes after cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 2, mode: "normal", yankBuffer: "XX" },
        ["p"]
      );
      expect(state.text).toBe("helXXlo");
      expect(state.cursor).toBe(4);
    });

    test("P pastes before cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 2, mode: "normal", yankBuffer: "XX" },
        ["P"]
      );
      expect(state.text).toBe("heXXllo");
      expect(state.cursor).toBe(2);
    });

    test("s substitutes character under cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 1, mode: "normal" },
        ["s"]
      );
      expect(state.text).toBe("hllo");
      expect(state.cursor).toBe(1);
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("e");
    });

    test("s at end of text does nothing", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 5, mode: "normal" },
        ["s"]
      );
      expect(state.text).toBe("hello");
      expect(state.mode).toBe("normal");
    });

    test("~ toggles case of character under cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "HeLLo", cursor: 0, mode: "normal" },
        ["~"]
      );
      expect(state.text).toBe("heLLo");
      expect(state.cursor).toBe(1);
    });

    test("~ toggles case and moves through word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "HeLLo", cursor: 0, mode: "normal" },
        ["~", "~", "~"]
      );
      expect(state.text).toBe("hElLo");
      expect(state.cursor).toBe(3);
    });

    test("~ on non-letter does nothing but advances cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "a 1 b", cursor: 1, mode: "normal" },
        ["~"]
      );
      expect(state.text).toBe("a 1 b");
      expect(state.cursor).toBe(2);
    });

    test("~ at end of text does not advance cursor", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 4, mode: "normal" },
        ["~"]
      );
      expect(state.text).toBe("hellO");
      expect(state.cursor).toBe(4);
    });
  });

  describe("Line Operations", () => {
    test("dd deletes line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\nworld\nfoo", cursor: 8, mode: "normal" },
        ["d", "d"]
      );
      expect(state.text).toBe("hello\nfoo");
      expect(state.yankBuffer).toBe("world\n");
    });

    test("yy yanks line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\nworld", cursor: 2, mode: "normal" },
        ["y", "y"]
      );
      expect(state.text).toBe("hello\nworld"); // Text unchanged
      expect(state.yankBuffer).toBe("hello\n");
    });

    test("cc changes line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\nworld\nfoo", cursor: 8, mode: "normal" },
        ["c", "c"]
      );
      expect(state.text).toBe("hello\n\nfoo");
      expect(state.mode).toBe("insert");
      expect(state.yankBuffer).toBe("world");
    });
  });

  describe("Operator + Motion: Delete", () => {
    test("d$ deletes to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["d", "$"]
      );
      expect(state.text).toBe("hello ");
      expect(state.cursor).toBe(6);
      expect(state.yankBuffer).toBe("world");
    });

    test("D deletes to end of line (shortcut)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["D"]
      );
      expect(state.text).toBe("hello ");
      expect(state.cursor).toBe(6);
    });

    test("d0 deletes to beginning of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["d", "0"]
      );
      expect(state.text).toBe("world");
      expect(state.yankBuffer).toBe("hello ");
    });

    test("dw deletes to next word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 0, mode: "normal" },
        ["d", "w"]
      );
      expect(state.text).toBe("world foo");
      expect(state.yankBuffer).toBe("hello ");
    });

    test("db deletes to previous word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 12, mode: "normal" },
        ["d", "b"]
      );
      expect(state.text).toBe("hello foo");
    });
  });

  describe("Operator + Motion: Change", () => {
    test("c$ changes to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["c", "$"]
      );
      expect(state.text).toBe("hello ");
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(6);
    });

    test("C changes to end of line (shortcut)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["C"]
      );
      expect(state.text).toBe("hello ");
      expect(state.mode).toBe("insert");
    });

    test("c0 changes to beginning of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["c", "0"]
      );
      expect(state.text).toBe("world");
      expect(state.mode).toBe("insert");
    });

    test("cw changes to next word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["c", "w"]
      );
      expect(state.text).toBe("world");
      expect(state.mode).toBe("insert");
    });
  });

  describe("Operator + Motion: Yank", () => {
    test("y$ yanks to end of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["y", "$"]
      );
      expect(state.text).toBe("hello world"); // Text unchanged
      expect(state.yankBuffer).toBe("world");
      expect(state.mode).toBe("normal");
    });

    test("y0 yanks to beginning of line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["y", "0"]
      );
      expect(state.text).toBe("hello world");
      expect(state.yankBuffer).toBe("hello ");
    });

    test("yw yanks to next word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 0, mode: "normal" },
        ["y", "w"]
      );
      expect(state.text).toBe("hello world");
      expect(state.yankBuffer).toBe("hello ");
    });
  });

  describe("Complex Workflows", () => {
    test("ESC then d$ deletes from insert cursor to end", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "insert" },
        ["Escape", "d", "$"]
      );
      // Cursor at 6 in insert mode stays at 6 after ESC (on 'w')
      // d$ deletes from 'w' to end of line
      expect(state.text).toBe("hello ");
      expect(state.mode).toBe("normal");
    });

    test("navigate with w, then delete with dw", () => {
      const state = executeVimCommands(
        { ...initialState, text: "one two three", cursor: 0, mode: "normal" },
        ["w", "d", "w"]
      );
      expect(state.text).toBe("one three");
    });

    test("yank line, navigate, paste", () => {
      const state = executeVimCommands(
        { ...initialState, text: "first\nsecond\nthird", cursor: 0, mode: "normal" },
        ["y", "y", "j", "j", "p"]
      );
      expect(state.yankBuffer).toBe("first\n");
      // After yy: cursor at 0, yank "first\n"
      // After jj: cursor moves down 2 lines to "third" (at index 13, on 't')
      // After p: pastes "first\n" after cursor position (character-wise in test harness)
      // Note: Real Vim would do line-wise paste, but test harness does character-wise
      expect(state.text).toBe("first\nsecond\ntfirst\nhird");
    });

    test("delete word, move, paste", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 0, mode: "normal" },
        ["d", "w", "w", "p"]
      );
      expect(state.yankBuffer).toBe("hello ");
      // After dw: text = "world foo", cursor at 0, yank "hello "
      // After w: cursor moves to start of "foo" (index 6)
      // After p: paste "hello " after cursor
      expect(state.text).toBe("world fhello oo");
    });
  });

  describe("Edge Cases", () => {
    test("$ on empty line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello\n\nworld", cursor: 6, mode: "normal" },
        ["$"]
      );
      expect(state.cursor).toBe(6); // Empty line, stays at newline char
    });

    test("w at end of text", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 4, mode: "normal" },
        ["w"]
      );
      expect(state.cursor).toBe(4); // Clamps to last char
    });

    test("d$ at end of line deletes last char", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 4, mode: "normal" },
        ["d", "$"]
      );
      // Cursor at 4 (on 'o'), d$ deletes from 'o' to line end
      expect(state.text).toBe("hell");
    });

    test("x at end of text does nothing", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello", cursor: 5, mode: "normal" },
        ["x"]
      );
      expect(state.text).toBe("hello");
    });
  });

  describe("Reported Issues", () => {
    test("issue #1: ciw should delete inner word correctly", () => {
      // User reported: "ciw sometimes leaves a blank character highlighted"
      // Root cause: test harness was treating 'w' in 'ciw' as a motion, not text object
      // This caused 'ciw' to behave like 'cw' (change word forward)
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 6, mode: "normal" },
        ["c", "i", "w"]
      );
      expect(state.text).toBe("hello  foo"); // Only "world" deleted, both spaces remain
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(6); // Cursor at start of deleted word
    });

    test("issue #2: o on last line should insert line below", () => {
      // In Vim: o opens new line below current line, even on last line
      const state = executeVimCommands(
        { ...initialState, text: "first\nsecond\nthird", cursor: 15, mode: "normal" },
        ["o"]
      );
      expect(state.mode).toBe("insert");
      expect(state.text).toBe("first\nsecond\nthird\n"); // New line added
      expect(state.cursor).toBe(19); // Cursor on new line
    });
  });

  describe("e/E motion", () => {
    test("e moves to end of current word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 1, mode: "normal" },
        ["e"]
      );
      expect(state.cursor).toBe(4);
    });

    test("de deletes to end of word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 1, mode: "normal" },
        ["d", "e"]
      );
      expect(state.text).toBe("h world");
      expect(state.yankBuffer).toBe("ello");
    });

    test("ce changes to end of word", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 1, mode: "normal" },
        ["c", "e"]
      );
      expect(state.text).toBe("h world");
      expect(state.mode).toBe("insert");
    });

    test("e at end of word moves to end of next word", () => {
      // Bug: when cursor is at end of word, 'e' should move to end of next word
      const state = executeVimCommands(
        { ...initialState, text: "hello world foo", cursor: 4, mode: "normal" }, // cursor on 'o' (end of "hello")
        ["e"]
      );
      expect(state.cursor).toBe(10); // Should move to end of "world" (not stay at 4)
    });

    test("e at end of word with punctuation moves correctly", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello, world", cursor: 4, mode: "normal" }, // cursor on 'o' (end of "hello")
        ["e"]
      );
      expect(state.cursor).toBe(11); // Should move to end of "world"
    });
  });

  describe("_ motion (first non-whitespace character)", () => {
    test("_ moves to first non-whitespace character", () => {
      const state = executeVimCommands(
        { ...initialState, text: "  hello world", cursor: 10, mode: "normal" },
        ["_"]
      );
      expect(state.cursor).toBe(2); // Should move to 'h' (first non-whitespace)
    });

    test("_ on line with no leading whitespace goes to position 0", () => {
      const state = executeVimCommands(
        { ...initialState, text: "hello world", cursor: 6, mode: "normal" },
        ["_"]
      );
      expect(state.cursor).toBe(0); // Should move to start of line
    });

    test("_ with tabs and spaces", () => {
      const state = executeVimCommands(
        { ...initialState, text: "\t  hello", cursor: 5, mode: "normal" },
        ["_"]
      );
      expect(state.cursor).toBe(3); // Should move to 'h' after tab and spaces
    });

    test("d_ deletes entire line and newline (linewise motion)", () => {
      const state = executeVimCommands(
        { ...initialState, text: "  hello world\nnext", cursor: 10, mode: "normal" },
        ["d", "_"]
      );
      expect(state.text).toBe("next"); // Entire current line removed (including newline)
      expect(state.cursor).toBe(0);
    });

    test("c_ changes entire line like cc", () => {
      const state = executeVimCommands(
        { ...initialState, text: "  hello world\nnext", cursor: 5, mode: "normal" },
        ["c", "_"]
      );
      expect(state.text).toBe("\nnext"); // Line cleared and enters insert mode
      expect(state.mode).toBe("insert");
      expect(state.cursor).toBe(0);
    });

    test("y_ yanks entire line", () => {
      const state = executeVimCommands(
        { ...initialState, text: "  hello world\nnext", cursor: 3, mode: "normal" },
        ["y", "_"]
      );
      expect(state.yankBuffer).toBe("  hello world\n");
      expect(state.text).toBe("  hello world\nnext");
    });
  });
});
