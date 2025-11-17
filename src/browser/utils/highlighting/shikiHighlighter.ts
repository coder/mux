import { createHighlighter, type Highlighter } from "shiki";
import { SHIKI_DARK_THEME, SHIKI_LIGHT_THEME } from "./shiki-shared";

export { SHIKI_DARK_THEME, SHIKI_LIGHT_THEME } from "./shiki-shared";

// Maximum diff size to highlight (in bytes)
// Diffs larger than this will fall back to plain text for performance
export const MAX_DIFF_SIZE_BYTES = 32768; // 32kb

// Singleton promise (cached to prevent race conditions)
// Multiple concurrent calls will await the same Promise
let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Get or create Shiki highlighter instance
 * Lazy-loads WASM and themes on first call
 * Thread-safe: concurrent calls share the same initialization Promise
 */
export async function getShikiHighlighter(): Promise<Highlighter> {
  // Must use if-check instead of ??= to prevent race condition
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME],
      langs: [], // Load languages on-demand via highlightDiffChunk
    });
  }
  return highlighterPromise;
}

/**
 * Map file extensions/languages to Shiki language IDs
 * Reuses existing getLanguageFromPath logic
 */
export function mapToShikiLang(detectedLang: string): string {
  // Most languages match 1:1, but handle special cases
  const mapping: Record<string, string> = {
    text: "plaintext",
    sh: "bash",
    // Add more mappings if needed
  };
  return mapping[detectedLang] || detectedLang;
}
