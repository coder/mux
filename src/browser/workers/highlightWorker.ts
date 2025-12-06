/**
 * Web Worker for syntax highlighting (Shiki)
 * Moves expensive highlighting work off the main thread
 */

import { createHighlighter, type Highlighter } from "shiki";
import { SHIKI_DARK_THEME, SHIKI_LIGHT_THEME } from "../utils/highlighting/shiki-shared";

// Message types for worker communication
export interface HighlightRequest {
  id: number;
  code: string;
  language: string;
  theme: "dark" | "light";
}

export interface HighlightResponse {
  id: number;
  html?: string;
  error?: string;
}

// Singleton highlighter instance within worker
let highlighter: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return highlighter;
  // Must use if-check instead of ??= to prevent race condition
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME],
      langs: [],
    });
  }
  highlighter = await highlighterPromise;
  return highlighter;
}

// Map detected language to Shiki language ID
function mapToShikiLang(detectedLang: string): string {
  const mapping: Record<string, string> = {
    text: "plaintext",
    sh: "bash",
  };
  return mapping[detectedLang] || detectedLang;
}

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  const { id, code, language, theme } = event.data;

  try {
    const hl = await getHighlighter();
    const shikiLang = mapToShikiLang(language);

    // Load language on-demand
    const loadedLangs = hl.getLoadedLanguages();
    if (!loadedLangs.includes(shikiLang)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        await hl.loadLanguage(shikiLang as any);
      } catch {
        // Language not available - signal error so caller can fallback
        self.postMessage({
          id,
          error: `Language '${shikiLang}' not available`,
        } satisfies HighlightResponse);
        return;
      }
    }

    const shikiTheme = theme === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
    const html = hl.codeToHtml(code, {
      lang: shikiLang,
      theme: shikiTheme,
    });

    self.postMessage({ id, html } satisfies HighlightResponse);
  } catch (err) {
    self.postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies HighlightResponse);
  }
};
