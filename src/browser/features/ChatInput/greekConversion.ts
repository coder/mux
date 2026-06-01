import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";

/**
 * Greek-letter autocomplete + auto-conversion for the chat input.
 *
 * Typing a LaTeX-style backslash command converts it to the matching Greek
 * letter as soon as the full name is typed: `\alpha` -> "α", `\Alpha` -> "Α".
 * Case of the command name selects the letter case (lowercase name -> lowercase
 * letter, capitalized name -> uppercase letter). Typing `\` also opens an
 * autocomplete menu (handled in ChatInput) that filters as the name is typed.
 *
 * Pure module so the matching/conversion logic stays unit-testable without React.
 */

// Built from String.fromCharCode so the source never contains a literal
// backslash (which is awkward to escape across our tooling/string layers).
const BACKSLASH = String.fromCharCode(92);

// Standard Greek letters with their lowercase and uppercase glyphs.
const GREEK_LETTERS: ReadonlyArray<{ name: string; lower: string; upper: string }> = [
  { name: "alpha", lower: "α", upper: "Α" },
  { name: "beta", lower: "β", upper: "Β" },
  { name: "gamma", lower: "γ", upper: "Γ" },
  { name: "delta", lower: "δ", upper: "Δ" },
  { name: "epsilon", lower: "ε", upper: "Ε" },
  { name: "zeta", lower: "ζ", upper: "Ζ" },
  { name: "eta", lower: "η", upper: "Η" },
  { name: "theta", lower: "θ", upper: "Θ" },
  { name: "iota", lower: "ι", upper: "Ι" },
  { name: "kappa", lower: "κ", upper: "Κ" },
  { name: "lambda", lower: "λ", upper: "Λ" },
  { name: "mu", lower: "μ", upper: "Μ" },
  { name: "nu", lower: "ν", upper: "Ν" },
  { name: "xi", lower: "ξ", upper: "Ξ" },
  { name: "omicron", lower: "ο", upper: "Ο" },
  { name: "pi", lower: "π", upper: "Π" },
  { name: "rho", lower: "ρ", upper: "Ρ" },
  { name: "sigma", lower: "σ", upper: "Σ" },
  { name: "tau", lower: "τ", upper: "Τ" },
  { name: "upsilon", lower: "υ", upper: "Υ" },
  { name: "phi", lower: "φ", upper: "Φ" },
  { name: "chi", lower: "χ", upper: "Χ" },
  { name: "psi", lower: "ψ", upper: "Ψ" },
  { name: "omega", lower: "ω", upper: "Ω" },
];

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

interface GreekEntry {
  /** Command name without the leading backslash, e.g. "alpha" or "Alpha". */
  name: string;
  /** The Greek character the name converts to. */
  char: string;
}

// Each base letter contributes a lowercase and a capitalized entry, grouped
// together so the empty-query menu lists "\alpha, \Alpha, \beta, \Beta, ...".
const GREEK_ENTRIES: readonly GreekEntry[] = GREEK_LETTERS.flatMap((letter) => [
  { name: letter.name, char: letter.lower },
  { name: capitalize(letter.name), char: letter.upper },
]);

const GREEK_BY_NAME: ReadonlyMap<string, string> = new Map(
  GREEK_ENTRIES.map((entry) => [entry.name, entry.char])
);

export interface GreekCommandMatch {
  /** Letters typed after the backslash (may be empty when only `\` is typed). */
  partial: string;
  /** Index of the triggering backslash. */
  startIndex: number;
  /** Index just past the last letter of the token. */
  endIndex: number;
}

const LETTER = /^[A-Za-z]$/;

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTER.test(ch);
}

/**
 * Locate a `\name` command surrounding the cursor. Walks left over letters to
 * find a backslash, then right over letters to capture the whole token (so we
 * never convert a name embedded in a longer run of letters). Returns null when
 * the cursor is not inside such a token.
 */
export function findGreekCommandAtCursor(text: string, cursor: number): GreekCommandMatch | null {
  if (
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor > text.length ||
    !text.includes(BACKSLASH)
  ) {
    return null;
  }

  let tokenStart = cursor;
  while (tokenStart > 0 && isLetter(text[tokenStart - 1])) {
    tokenStart--;
  }

  const backslashIndex = tokenStart - 1;
  if (backslashIndex < 0 || text[backslashIndex] !== BACKSLASH) {
    return null;
  }

  // A preceding backslash (`\alpha`) is treated as an escape so users can write
  // a literal backslash command without it converting.
  if (backslashIndex > 0 && text[backslashIndex - 1] === BACKSLASH) {
    return null;
  }

  let tokenEnd = cursor;
  while (tokenEnd < text.length && isLetter(text[tokenEnd])) {
    tokenEnd++;
  }

  return {
    partial: text.slice(backslashIndex + 1, tokenEnd),
    startIndex: backslashIndex,
    endIndex: tokenEnd,
  };
}

/**
 * Suggestions for the autocomplete menu. Matching is case-sensitive on purpose:
 * the case of the typed name selects the letter case, so `\a` offers `\alpha`
 * while `\A` offers `\Alpha`. An empty partial (just `\`) lists everything.
 */
export function getGreekSuggestions(partial: string): SlashSuggestion[] {
  return GREEK_ENTRIES.filter((entry) => entry.name.startsWith(partial)).map((entry) => ({
    id: `greek:${entry.name}`,
    display: `${BACKSLASH}${entry.name}`,
    description: entry.char,
    replacement: entry.char,
  }));
}

/**
 * Convert a completed `\name` command at the cursor into its Greek letter.
 * Only fires when the cursor sits at the end of the token and the full name is
 * an exact (case-sensitive) match, so partial/mid-word edits are left alone.
 */
export function convertGreekCommandAtCursor(
  text: string,
  cursor: number
): { text: string; cursor: number } | null {
  const match = findGreekCommandAtCursor(text, cursor);
  if (cursor !== match?.endIndex) {
    return null;
  }

  const char = GREEK_BY_NAME.get(match.partial);
  if (char === undefined) {
    return null;
  }

  return {
    text: text.slice(0, match.startIndex) + char + text.slice(match.endIndex),
    cursor: match.startIndex + char.length,
  };
}
