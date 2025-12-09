import { highlightCode } from "./highlightWorkerClient";
import type { DiffChunk } from "./diffChunking";

/**
 * Chunk-based diff highlighting with Shiki (via Web Worker)
 *
 * Highlighting runs off-main-thread to avoid blocking UI during large diffs.
 *
 * Current approach: Parse Shiki HTML to extract individual line HTMLs
 * - Groups consecutive lines by type (add/remove/context)
 * - Highlights each chunk with Shiki in web worker
 * - Extracts per-line HTML for individual rendering
 *
 * Future optimization: Could render entire <code> blocks and use CSS to style
 * .line spans instead of extracting per-line HTML. Would simplify parsing
 * and reduce dangerouslySetInnerHTML usage.
 */

// Maximum diff size to highlight (in bytes)
// Diffs larger than this fall back to plain text for performance
const MAX_DIFF_SIZE_BYTES = 32768; // 32kb

export interface HighlightedLine {
  html: string; // HTML content (already escaped and tokenized)
  lineNumber: number;
  originalIndex: number; // Index in original diff
}

import type { ThemeMode } from "@/browser/contexts/ThemeContext";

/** Map theme mode to Shiki theme (light/dark only) */
function isLightTheme(theme: ThemeMode): boolean {
  return theme === "light" || theme === "solarized-light";
}

export interface HighlightedChunk {
  type: DiffChunk["type"];
  lines: HighlightedLine[];
  usedFallback: boolean; // True if highlighting failed
}

/**
 * Highlight a chunk of code using Shiki
 * Falls back to plain text on error
 */
export async function highlightDiffChunk(
  chunk: DiffChunk,
  language: string,
  themeMode: ThemeMode = "dark"
): Promise<HighlightedChunk> {
  // Fast path: no highlighting for text files
  if (language === "text" || language === "plaintext") {
    return {
      type: chunk.type,
      lines: chunk.lines.map((line, i) => ({
        html: escapeHtml(line),
        lineNumber: chunk.lineNumbers[i],
        originalIndex: chunk.startIndex + i,
      })),
      usedFallback: false,
    };
  }

  // Enforce size limit for performance
  // Calculate size by summing line lengths + newlines (more performant than TextEncoder)
  const sizeBytes =
    chunk.lines.reduce((total, line) => total + line.length, 0) + chunk.lines.length - 1;
  if (sizeBytes > MAX_DIFF_SIZE_BYTES) {
    return createFallbackChunk(chunk);
  }

  const code = chunk.lines.join("\n");
  const workerTheme = isLightTheme(themeMode) ? "light" : "dark";

  try {
    // Highlight via worker (cached, off main thread)
    const html = await highlightCode(code, language, workerTheme);

    // Parse HTML to extract line contents
    const lines = extractLinesFromHtml(html);

    // Validate output (detect broken highlighting)
    if (lines.length !== chunk.lines.length) {
      // Mismatch - highlighting broke the structure
      return createFallbackChunk(chunk);
    }

    // Check if any non-empty line became empty after extraction (indicates malformed HTML)
    // This prevents rendering empty spans when original line had content (especially whitespace)
    const hasEmptyExtraction = lines.some(
      (extractedHtml, i) => extractedHtml.length === 0 && chunk.lines[i].length > 0
    );
    if (hasEmptyExtraction) {
      return createFallbackChunk(chunk);
    }

    return {
      type: chunk.type,
      lines: lines.map((html, i) => ({
        html,
        lineNumber: chunk.lineNumbers[i],
        originalIndex: chunk.startIndex + i,
      })),
      usedFallback: false,
    };
  } catch (error) {
    console.warn(`Syntax highlighting failed for language ${language}:`, error);
    return createFallbackChunk(chunk);
  }
}

/**
 * Create plain text fallback for a chunk
 */
function createFallbackChunk(chunk: DiffChunk): HighlightedChunk {
  return {
    type: chunk.type,
    lines: chunk.lines.map((line, i) => ({
      html: escapeHtml(line),
      lineNumber: chunk.lineNumbers[i],
      originalIndex: chunk.startIndex + i,
    })),
    usedFallback: true,
  };
}

/**
 * Extract individual line contents from Shiki's HTML output
 * Shiki wraps output in <pre><code>...</code></pre> with <span class="line">...</span> per line
 *
 * Strategy: Split on newlines (which separate line spans), then extract inner HTML
 * from each line span. This handles nested spans correctly.
 */
function extractLinesFromHtml(html: string): string[] {
  // Remove <pre> and <code> wrappers
  const codeRegex = /<code[^>]*>(.*?)<\/code>/s;
  const codeMatch = codeRegex.exec(html);
  if (!codeMatch) return [];

  const codeContent = codeMatch[1];

  // Split by newlines - Shiki separates line spans with \n
  const lineChunks = codeContent.split("\n");

  return lineChunks
    .map((chunk) => {
      // Extract content from <span class="line">CONTENT</span>
      // We need to handle nested spans, so we:
      // 1. Find the opening tag
      // 2. Find the LAST closing </span> (which closes the line wrapper)
      // 3. Extract everything between them

      const openTag = '<span class="line">';
      const closeTag = "</span>";

      const openIndex = chunk.indexOf(openTag);
      if (openIndex === -1) {
        // No line span - might be empty line or malformed
        return "";
      }

      const contentStart = openIndex + openTag.length;
      const closeIndex = chunk.lastIndexOf(closeTag);
      if (closeIndex === -1 || closeIndex < contentStart) {
        // Malformed - no closing tag
        return "";
      }

      return chunk.substring(contentStart, closeIndex);
    })
    .filter((line) => line !== null); // Remove malformed lines
}

/**
 * Escape HTML entities for plain text fallback
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
