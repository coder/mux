import { describe, expect, test } from "bun:test";
import {
  convertSymbolCommandAtCursor,
  convertTerminatedSymbolCommand,
  findSymbolCommandAtCursor,
  getSymbolSuggestions,
} from "@/browser/features/ChatInput/symbolShortcuts";

// Build backslash-prefixed inputs without literal backslashes in source.
const bs = String.fromCharCode(92);
const cmd = (name: string) => `${bs}${name}`;

describe("findSymbolCommandAtCursor", () => {
  test("matches a partial command at the cursor", () => {
    expect(findSymbolCommandAtCursor(cmd("al"), 3)).toEqual({
      partial: "al",
      startIndex: 0,
      endIndex: 3,
    });
  });

  test("matches the bare trigger with an empty partial", () => {
    expect(findSymbolCommandAtCursor(bs, 1)).toEqual({ partial: "", startIndex: 0, endIndex: 1 });
  });

  test("captures the full token even when the caret is mid-word", () => {
    expect(findSymbolCommandAtCursor(cmd("alpha"), 3)).toEqual({
      partial: "alpha",
      startIndex: 0,
      endIndex: 6,
    });
  });

  test("returns null without a trigger and ignores escaped triggers", () => {
    expect(findSymbolCommandAtCursor("alpha", 5)).toBeNull();
    expect(findSymbolCommandAtCursor(`${bs}${bs}alpha`, 7)).toBeNull();
  });

  test("does not match inside inline code or fenced blocks", () => {
    // Inline code span: `\div`
    expect(findSymbolCommandAtCursor("`" + cmd("div") + "`", 5)).toBeNull();
    // Fenced block
    const fenced = "```\n" + cmd("sum") + "\n```";
    const cursorInFence = fenced.indexOf("m") + 1;
    expect(findSymbolCommandAtCursor(fenced, cursorInFence)).toBeNull();
    // Same token outside code still matches
    expect(findSymbolCommandAtCursor(cmd("div"), 4)?.partial).toBe("div");
  });
});

describe("getSymbolSuggestions", () => {
  test("filtering is case-sensitive so name case picks glyph case", () => {
    const lower = getSymbolSuggestions("a");
    expect(lower.map((s) => s.display)).toEqual([
      cmd("alpha"),
      cmd("ast"),
      cmd("approx"),
      cmd("angle"),
    ]);
    const upper = getSymbolSuggestions("A");
    expect(upper.map((s) => s.display)).toEqual([cmd("Alpha")]);
  });

  test("an exact match is the default (first) suggestion so Tab accepts it", () => {
    // Regression: typing "\in" + Tab must yield ∈, not ∞/∫ — the exact match
    // floats above its longer prefix-completions.
    expect(getSymbolSuggestions("in")[0]?.display).toBe(cmd("in"));
    expect(getSymbolSuggestions("in")[0]?.replacement).toBe("∈");
    expect(getSymbolSuggestions("to")[0]?.display).toBe(cmd("to"));
    expect(getSymbolSuggestions("subset")[0]?.display).toBe(cmd("subset"));
  });

  test("non-exact queries keep curated order (no shorter-sibling hijack)", () => {
    // "\a" has no exact match, so the curated Greek-first ordering stands and
    // \alpha remains the default rather than the shorter \ast.
    expect(getSymbolSuggestions("a")[0]?.display).toBe(cmd("alpha"));
  });

  test("prefix-colliding names all appear in the menu", () => {
    expect(
      getSymbolSuggestions("in")
        .map((s) => s.display)
        .sort()
    ).toEqual([cmd("in"), cmd("infty"), cmd("int")].sort());
    expect(
      getSymbolSuggestions("sub")
        .map((s) => s.display)
        .sort()
    ).toEqual([cmd("subset"), cmd("subseteq")].sort());
    // Single-letter set names collide with capitalized Greek + arrows.
    expect(
      getSymbolSuggestions("R")
        .map((s) => s.display)
        .sort()
    ).toEqual([cmd("R"), cmd("Rho"), cmd("Rightarrow")].sort());
  });

  test("each suggestion's replacement matches its glyph", () => {
    for (const s of getSymbolSuggestions("")) {
      expect(s.replacement).toBe(s.description);
      expect(s.display.startsWith(bs)).toBe(true);
    }
  });

  test("command names are unique", () => {
    const names = getSymbolSuggestions("").map((s) => s.display);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no match yields no suggestions", () => {
    expect(getSymbolSuggestions("zzz")).toEqual([]);
  });
});

describe("convertSymbolCommandAtCursor (eager, unambiguous only)", () => {
  test("converts completed Greek commands by case", () => {
    expect(convertSymbolCommandAtCursor(cmd("alpha"), 6)).toEqual({ text: "α", cursor: 1 });
    expect(convertSymbolCommandAtCursor(cmd("Alpha"), 6)).toEqual({ text: "Α", cursor: 1 });
  });

  test("converts representative symbols across categories", () => {
    expect(convertSymbolCommandAtCursor(cmd("leq"), 4)?.text).toBe("≤"); // math
    expect(convertSymbolCommandAtCursor(cmd("times"), 6)?.text).toBe("×"); // math
    expect(convertSymbolCommandAtCursor(cmd("subseteq"), 9)?.text).toBe("⊆"); // set
    expect(convertSymbolCommandAtCursor(cmd("implies"), 8)?.text).toBe("⟹"); // logic
    expect(convertSymbolCommandAtCursor(cmd("rightarrow"), 11)?.text).toBe("→"); // arrow
    expect(convertSymbolCommandAtCursor(cmd("euro"), 5)?.text).toBe("€"); // currency
    expect(convertSymbolCommandAtCursor(cmd("bitcoin"), 8)?.text).toBe("₿"); // currency
    expect(convertSymbolCommandAtCursor(cmd("sum"), 4)?.text).toBe("∑"); // bigop
  });

  test("converts in place within surrounding text", () => {
    expect(convertSymbolCommandAtCursor(`x ${cmd("geq")}`, 6)).toEqual({ text: "x ≥", cursor: 3 });
  });

  test("does NOT eager-convert a name that is a prefix of another", () => {
    expect(convertSymbolCommandAtCursor(cmd("in"), 3)).toBeNull(); // prefix of int/infty
    expect(convertSymbolCommandAtCursor(cmd("to"), 3)).toBeNull(); // prefix of top
    expect(convertSymbolCommandAtCursor(cmd("subset"), 7)).toBeNull(); // prefix of subseteq
    expect(convertSymbolCommandAtCursor(cmd("R"), 2)).toBeNull(); // prefix of Rho/Rightarrow
  });

  test("eager-converts once the name becomes unambiguous", () => {
    expect(convertSymbolCommandAtCursor(cmd("int"), 4)).toEqual({ text: "∫", cursor: 1 });
    expect(convertSymbolCommandAtCursor(cmd("top"), 4)).toEqual({ text: "⊤", cursor: 1 });
    expect(convertSymbolCommandAtCursor(cmd("subseteq"), 9)).toEqual({ text: "⊆", cursor: 1 });
  });

  test("does not convert a partial, unknown, or mid-token name", () => {
    expect(convertSymbolCommandAtCursor(cmd("alph"), 5)).toBeNull();
    expect(convertSymbolCommandAtCursor(cmd("alphax"), 7)).toBeNull();
    expect(convertSymbolCommandAtCursor(cmd("alpha"), 3)).toBeNull();
  });

  test("does not convert an escaped command", () => {
    expect(convertSymbolCommandAtCursor(`${bs}${bs}alpha`, 7)).toBeNull();
  });
});

describe("convertTerminatedSymbolCommand (accept on space/punctuation)", () => {
  test("converts an ambiguous name when a terminator follows", () => {
    expect(convertTerminatedSymbolCommand(cmd("in") + " ", 4)).toEqual({ text: "∈ ", cursor: 2 });
    expect(convertTerminatedSymbolCommand(cmd("subset") + ")", 8)).toEqual({
      text: "⊂)",
      cursor: 2,
    });
    expect(convertTerminatedSymbolCommand(cmd("R") + ")", 3)).toEqual({ text: "ℝ)", cursor: 2 });
  });

  test("converts a pasted unambiguous run ending in a terminator", () => {
    expect(convertTerminatedSymbolCommand(cmd("alpha") + " ", 7)).toEqual({
      text: "α ",
      cursor: 2,
    });
  });

  test("does nothing without a terminator or for unknown names", () => {
    expect(convertTerminatedSymbolCommand(cmd("in"), 3)).toBeNull(); // no terminator
    expect(convertTerminatedSymbolCommand(cmd("nope") + " ", 6)).toBeNull();
  });

  test("does not convert an escaped command on terminator", () => {
    expect(convertTerminatedSymbolCommand(`${bs}${bs}in `, 5)).toBeNull();
  });
});
