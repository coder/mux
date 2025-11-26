#!/usr/bin/env bun
/**
 * mdBook preprocessor for static Shiki syntax highlighting
 * Implements the mdBook preprocessor protocol:
 * https://rust-lang.github.io/mdBook/format/configuration/preprocessors.html
 */

import { createHighlighter } from "shiki";
import { SHIKI_DARK_THEME, mapToShikiLang, extractShikiLines } from "../src/browser/utils/highlighting/shiki-shared";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeBlockSSR } from "../src/browser/components/Messages/CodeBlockSSR";

interface Chapter {
  name: string;
  content?: string;
  number?: number[];
  sub_items?: Section[];
  path?: string;
  source_path?: string;
  parent_names?: string[];
}

interface Section {
  Chapter?: Chapter;
}

interface Book {
  sections: Section[];
  __non_exhaustive: null;
}

interface Context {
  root: string;
  config: unknown;
  renderer: string;
  mdbook_version: string;
}

type PreprocessorInput = [Context, Book];

/**
 * Generate HTML grid layout with line numbers from Shiki output
 * Uses the SSR component to ensure consistency with main app
 */
function generateGridHtml(shikiHtml: string, originalCode: string): string {
  const lines = extractShikiLines(shikiHtml);
  
  // Render the React component to static HTML
  const html = renderToStaticMarkup(
    CodeBlockSSR({ code: originalCode, highlightedLines: lines })
  );
  
  return html;
}

/**
 * Process markdown content to replace code blocks with highlighted HTML
 */
async function processMarkdown(content: string, highlighter: Awaited<ReturnType<typeof createHighlighter>>): Promise<string> {
  // Match ```lang\ncode\n``` blocks (lang is optional)
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  
  let result = content;
  const matches = Array.from(content.matchAll(codeBlockRegex));
  
  for (const match of matches) {
    const [fullMatch, lang, code] = match;
    // Default to plaintext if no language specified
    const shikiLang = mapToShikiLang(lang || "plaintext");
    
    // Remove trailing newlines from code (markdown often has extra newline before closing ```)
    const trimmedCode = code.replace(/\n+$/, "");
    
    try {
      // Load language if needed
      const loadedLangs = highlighter.getLoadedLanguages();
      if (!loadedLangs.includes(shikiLang)) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await highlighter.loadLanguage(shikiLang as any);
        } catch {
          // Language not available, skip highlighting
          console.warn(`[mdbook-shiki] Language '${shikiLang}' not available, skipping`);
          continue;
        }
      }
      
      const html = highlighter.codeToHtml(trimmedCode, {
        lang: shikiLang,
        theme: SHIKI_DARK_THEME,
      });
      
      const gridHtml = generateGridHtml(html, trimmedCode);
      
      // Remove newlines from HTML to prevent mdBook from treating it as markdown
      // mdBook only parses multi-line content as markdown; single-line HTML is passed through
      const singleLineHtml = gridHtml.replace(/\n/g, '');
      
      result = result.replace(fullMatch, singleLineHtml);
    } catch (error) {
      console.warn(`[mdbook-shiki] Failed to highlight code block (${lang}):`, error);
      // Keep original code block on error
    }
  }
  
  return result;
}

/**
 * Recursively process all chapters in a section
 */
async function processChapter(chapter: Chapter, highlighter: Awaited<ReturnType<typeof createHighlighter>>): Promise<void> {
  if (chapter.content) {
    chapter.content = await processMarkdown(chapter.content, highlighter);
  }
  
  if (chapter.sub_items) {
    for (const subItem of chapter.sub_items) {
      if (subItem.Chapter) {
        await processChapter(subItem.Chapter, highlighter);
      }
    }
  }
}

/**
 * Main preprocessor entry point
 */
async function main() {
  // Read input from stdin
  const stdinText = await Bun.stdin.text();
  
  // Check for "supports" query
  const trimmed = stdinText.trim();
  if (trimmed.startsWith('["supports"')) {
    // We support all renderers
    console.log("true");
    process.exit(0);
  }
  
  // Empty input - exit cleanly
  if (!trimmed) {
    process.exit(0);
  }
  
  // Parse the preprocessor input
  const [context, book]: PreprocessorInput = JSON.parse(trimmed);
  
  // Initialize Shiki highlighter
  const highlighter = await createHighlighter({
    themes: [SHIKI_DARK_THEME],
    langs: [], // Load on-demand
  });
  
  // Process all sections
  for (const section of book.sections) {
    if (section.Chapter) {
      await processChapter(section.Chapter, highlighter);
    }
  }
  
  // Output the modified book
  console.log(JSON.stringify(book));
}

// Run the preprocessor
main().catch((error) => {
  console.error("[mdbook-shiki] Fatal error:", error);
  process.exit(1);
});
