import { describe, expect, test } from "bun:test";
import {
  convertGreekCommandAtCursor,
  findGreekCommandAtCursor,
  getGreekSuggestions,
} from "@/browser/features/ChatInput/greekConversion";

// Build backslash-prefixed inputs without literal backslashes in source.
const bs = String.fromCharCode(92);

describe("findGreekCommandAtCursor", () => {
  test("matches a partial backslash command at the cursor", () => {
    expect(findGreekCommandAtCursor(`${bs}al`, 3)).toEqual({
      partial: "al",
      startIndex: 0,
      endIndex: 3,
    });
  });

  test("matches the bare backslash with an empty partial", () => {
    expect(findGreekCommandAtCursor(bs, 1)).toEqual({
      partial: "",
      startIndex: 0,
      endIndex: 1,
    });
  });

  test("captures the full token even when the caret is mid-word", () => {
    // Caret after "\al" but the run continues with "pha"; the whole token is returned.
    expect(findGreekCommandAtCursor(`${bs}alpha`, 3)).toEqual({
      partial: "alpha",
      startIndex: 0,
      endIndex: 6,
    });
  });

  test("returns null without a backslash and ignores escaped backslashes", () => {
    expect(findGreekCommandAtCursor("alpha", 5)).toBeNull();
    expect(findGreekCommandAtCursor(`${bs}${bs}alpha`, 7)).toBeNull();
  });
});

describe("getGreekSuggestions", () => {
  test("filtering is case-sensitive so name case picks letter case", () => {
    const lower = getGreekSuggestions("a");
    expect(lower.map((s) => s.display)).toEqual([`${bs}alpha`]);
    expect(lower[0]?.replacement).toBe("α");

    const upper = getGreekSuggestions("A");
    expect(upper.map((s) => s.display)).toEqual([`${bs}Alpha`]);
    expect(upper[0]?.replacement).toBe("Α");
  });

  test("a shared prefix returns every matching letter of that case", () => {
    expect(getGreekSuggestions("p").map((s) => s.display)).toEqual([
      `${bs}pi`,
      `${bs}phi`,
      `${bs}psi`,
    ]);
    expect(getGreekSuggestions("P").map((s) => s.display)).toEqual([
      `${bs}Pi`,
      `${bs}Phi`,
      `${bs}Psi`,
    ]);
  });

  test("an empty partial lists all 24 letters in both cases", () => {
    expect(getGreekSuggestions("")).toHaveLength(48);
  });

  test("no match yields no suggestions", () => {
    expect(getGreekSuggestions("zzz")).toEqual([]);
  });
});

describe("convertGreekCommandAtCursor", () => {
  test("converts a completed lowercase command", () => {
    expect(convertGreekCommandAtCursor(`${bs}alpha`, 6)).toEqual({ text: "α", cursor: 1 });
  });

  test("converts a completed capitalized command to the uppercase letter", () => {
    expect(convertGreekCommandAtCursor(`${bs}Alpha`, 6)).toEqual({ text: "Α", cursor: 1 });
  });

  test("converts in place within surrounding text", () => {
    expect(convertGreekCommandAtCursor(`x = ${bs}beta`, 9)).toEqual({ text: "x = β", cursor: 5 });
  });

  test("does not convert a partial or unknown name", () => {
    expect(convertGreekCommandAtCursor(`${bs}alph`, 5)).toBeNull();
    expect(convertGreekCommandAtCursor(`${bs}alphax`, 7)).toBeNull();
  });

  test("does not convert when the caret is not at the end of the token", () => {
    expect(convertGreekCommandAtCursor(`${bs}alpha`, 3)).toBeNull();
  });

  test("does not convert an escaped backslash command", () => {
    expect(convertGreekCommandAtCursor(`${bs}${bs}alpha`, 7)).toBeNull();
  });
});
