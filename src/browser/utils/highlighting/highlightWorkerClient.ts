/**
 * Syntax highlighting client
 *
 * Provides async API for off-main-thread syntax highlighting via Web Worker.
 * Falls back to main-thread highlighting in test environments where
 * Web Workers aren't available.
 *
 * Note: Caching happens at the caller level (DiffRenderer's highlightedDiffCache)
 * to enable synchronous cache hits and avoid "Processing" flash.
 */

import * as Comlink from "comlink";
import type { Highlighter } from "shiki";
import type { HighlightWorkerAPI } from "@/browser/workers/highlightWorker";
import { mapToShikiLang, SHIKI_DARK_THEME, SHIKI_LIGHT_THEME } from "./shiki-shared";
import { isVscodeWebview } from "@/browser/utils/env";

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
let warnedVscodeWorkerDisabled = false;

function getWorkerAPI(): Comlink.Remote<HighlightWorkerAPI> | null {
  // VS Code webviews load the chat UI from a bundled ESM file.
  // Our current webview bundling does not ship the worker entrypoint referenced by
  // `new URL("../../workers/highlightWorker.ts", import.meta.url)`, which means the
  // worker will fail to start and Comlink calls can hang.
  //
  // Prefer correctness and responsiveness: fall back to the main-thread highlighter.
  if (isVscodeWebview()) {
    if (!warnedVscodeWorkerDisabled) {
      warnedVscodeWorkerDisabled = true;
      console.warn("[highlightWorkerClient] Worker highlighting disabled in VS Code webview");
    }

    workerFailed = true;
    workerAPI = null;
    return null;
  }

  if (workerFailed) return null;
  if (workerAPI) return workerAPI;

  try {
    // Use relative path - @/ alias doesn't work in worker context.
    const worker = new Worker(new URL("../../workers/highlightWorker.ts", import.meta.url), {
      type: "module",
      name: "shiki-highlighter", // Shows up in DevTools
    });

    worker.onerror = (e) => {
      console.error("[highlightWorkerClient] Worker failed to load:", e);
      workerFailed = true;
      workerAPI = null;
    };

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
 * Highlight code with syntax highlighting (off-main-thread)
 *
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
  const api = getWorkerAPI();
  if (!api) {
    return highlightMainThread(code, language, theme);
  }

  try {
    return await api.highlight(code, language, theme);
  } catch (e) {
    // Defensive fallback: if the worker crashes or fails to respond, keep rendering.
    console.error(
      "[highlightWorkerClient] Worker highlight failed; falling back to main thread:",
      e
    );
    workerFailed = true;
    workerAPI = null;
    return highlightMainThread(code, language, theme);
  }
}
