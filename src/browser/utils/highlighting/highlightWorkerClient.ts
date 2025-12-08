/**
 * Syntax highlighting client with LRU caching
 *
 * Provides async API for off-main-thread syntax highlighting via Web Worker.
 * Results are cached to avoid redundant highlighting of identical code.
 *
 * Falls back to main-thread highlighting in test environments where
 * Web Workers aren't available.
 */

import { LRUCache } from "lru-cache";
import * as Comlink from "comlink";
import type { Highlighter } from "shiki";
import type { HighlightWorkerAPI } from "@/browser/workers/highlightWorker";
import { mapToShikiLang, SHIKI_DARK_THEME, SHIKI_LIGHT_THEME } from "./shiki-shared";

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache with SHA-256 hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache for highlighted HTML results
 * Key: First 64 bits of SHA-256 hash (hex string)
 * Value: Shiki HTML output
 */
const highlightCache = new LRUCache<string, string>({
  max: 10000, // High limit — rely on maxSize for eviction
  maxSize: 8 * 1024 * 1024, // 8MB total
  sizeCalculation: (html) => html.length * 2, // Rough bytes for JS strings
});

async function getCacheKey(code: string, language: string, theme: string): Promise<string> {
  const data = new TextEncoder().encode(`${language}:${theme}:${code}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  // Take first 8 bytes (64 bits) as hex
  return Array.from(new Uint8Array(hash).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main-thread Shiki (fallback only)
// ─────────────────────────────────────────────────────────────────────────────

let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Get or create main-thread Shiki highlighter (for fallback when worker unavailable)
 * Uses dynamic import to avoid loading Shiki on main thread unless actually needed.
 */
async function getShikiHighlighter(): Promise<Highlighter> {
  // Must use if-check instead of ??= to prevent race condition
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME],
        langs: [],
      })
    );
  }
  return highlighterPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Management (via Comlink)
// ─────────────────────────────────────────────────────────────────────────────

let workerAPI: Comlink.Remote<HighlightWorkerAPI> | null = null;
let workerFailed = false;

function getWorkerAPI(): Comlink.Remote<HighlightWorkerAPI> | null {
  if (workerFailed) return null;
  if (workerAPI) return workerAPI;

  try {
    // Use relative path - @/ alias doesn't work in worker context
    const worker = new Worker(new URL("../../workers/highlightWorker.ts", import.meta.url), {
      type: "module",
      name: "shiki-highlighter", // Shows up in DevTools
    });

    worker.onerror = (e) => {
      console.error("[highlightWorkerClient] Worker failed to load:", e);
      workerFailed = true;
      workerAPI = null;
    };

    console.log("[highlightWorkerClient] Worker created successfully");
    workerAPI = Comlink.wrap<HighlightWorkerAPI>(worker);
    return workerAPI;
  } catch (e) {
    // Workers not available (e.g., test environment)
    console.error("[highlightWorkerClient] Failed to create worker:", e);
    workerFailed = true;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main-thread Fallback
// ─────────────────────────────────────────────────────────────────────────────

let warnedMainThread = false;

async function highlightMainThread(
  code: string,
  language: string,
  theme: "dark" | "light"
): Promise<string> {
  if (!warnedMainThread) {
    warnedMainThread = true;
    console.warn(
      "[highlightWorkerClient] Syntax highlighting running on main thread (worker unavailable)"
    );
  }

  const highlighter = await getShikiHighlighter();
  const shikiLang = mapToShikiLang(language);

  // Load language on-demand
  const loadedLangs = highlighter.getLoadedLanguages();
  if (!loadedLangs.includes(shikiLang)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    await highlighter.loadLanguage(shikiLang as any);
  }

  const shikiTheme = theme === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
  return highlighter.codeToHtml(code, {
    lang: shikiLang,
    theme: shikiTheme,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Highlight code with syntax highlighting (cached, off-main-thread)
 *
 * Results are cached by (code, language, theme) to avoid redundant work.
 * Highlighting runs in a Web Worker to avoid blocking the main thread.
 *
 * @param code - Source code to highlight
 * @param language - Language identifier (e.g., "typescript", "python")
 * @param theme - Theme variant ("dark" or "light")
 * @returns Promise resolving to HTML string with syntax highlighting
 * @throws Error if highlighting fails (caller should fallback to plain text)
 */
export async function highlightCode(
  code: string,
  language: string,
  theme: "dark" | "light"
): Promise<string> {
  // Check cache first
  const cacheKey = await getCacheKey(code, language, theme);
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;

  // Dispatch to worker or main-thread fallback
  const api = getWorkerAPI();
  let html: string;

  if (!api) {
    html = await highlightMainThread(code, language, theme);
  } else {
    html = await api.highlight(code, language, theme);
  }

  // Cache result
  highlightCache.set(cacheKey, html);
  return html;
}
