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
import CRC32 from "crc-32";
import { createHighlighter, type Highlighter } from "shiki";
import type { HighlightRequest, HighlightResponse } from "@/browser/workers/highlightWorker";
import { mapToShikiLang, SHIKI_DARK_THEME, SHIKI_LIGHT_THEME } from "./shiki-shared";

// ─────────────────────────────────────────────────────────────────────────────
// LRU Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache for highlighted HTML results
 * Key: CRC32 hash of (language:theme:code)
 * Value: Shiki HTML output
 */
const highlightCache = new LRUCache<number, string>({
  max: 10000, // High limit — rely on maxSize for eviction
  maxSize: 8 * 1024 * 1024, // 8MB total
  sizeCalculation: (html) => html.length * 2, // Rough bytes for JS strings
});

function getCacheKey(code: string, language: string, theme: string): number {
  return CRC32.str(`${language}:${theme}:${code}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main-thread Shiki (fallback only)
// ─────────────────────────────────────────────────────────────────────────────

let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Get or create main-thread Shiki highlighter (for fallback when worker unavailable)
 */
function getShikiHighlighter(): Promise<Highlighter> {
  // Must use if-check instead of ??= to prevent race condition
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME],
      langs: [],
    });
  }
  return highlighterPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Management
// ─────────────────────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerFailed = false;
let requestId = 0;

const pendingRequests = new Map<
  number,
  {
    resolve: (html: string) => void;
    reject: (error: Error) => void;
  }
>();

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;

  try {
    // Use relative path - @/ alias doesn't work in worker context
    worker = new Worker(new URL("../../workers/highlightWorker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
      const { id, html, error } = event.data;
      const pending = pendingRequests.get(id);
      if (!pending) return;

      pendingRequests.delete(id);
      if (error) {
        pending.reject(new Error(error));
      } else if (html !== undefined) {
        pending.resolve(html);
      } else {
        pending.reject(new Error("No HTML returned from worker"));
      }
    };

    worker.onerror = (error) => {
      console.error("Highlight worker error:", error);
      // Mark worker as failed so subsequent calls use main-thread fallback
      workerFailed = true;
      worker = null;
      // Reject all pending requests on worker error
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error("Worker error"));
        pendingRequests.delete(id);
      }
    };

    return worker;
  } catch {
    // Workers not available (e.g., test environment)
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
  const cacheKey = getCacheKey(code, language, theme);
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;

  // Dispatch to worker or main-thread fallback
  const w = getWorker();
  let html: string;

  if (!w) {
    html = await highlightMainThread(code, language, theme);
  } else {
    const id = requestId++;
    html = await new Promise<string>((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      w.postMessage({ id, code, language, theme } satisfies HighlightRequest);
    });
  }

  // Cache result
  highlightCache.set(cacheKey, html);
  return html;
}
