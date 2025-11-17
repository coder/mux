import type { ReactNode } from "react";
import React, { useState, useEffect } from "react";
import { Mermaid } from "./Mermaid";
import {
  getShikiHighlighter,
  mapToShikiLang,
  SHIKI_DARK_THEME,
  SHIKI_LIGHT_THEME,
} from "@/browser/utils/highlighting/shikiHighlighter";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { extractShikiLines } from "@/browser/utils/highlighting/shiki-shared";
import { CopyButton } from "@/browser/components/ui/CopyButton";

interface CodeProps {
  node?: unknown;
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

interface PreProps {
  children?: ReactNode;
}

interface DetailsProps {
  children?: ReactNode;
  open?: boolean;
}

interface SummaryProps {
  children?: ReactNode;
}

interface AnchorProps {
  href?: string;
  children?: ReactNode;
}

interface CodeBlockProps {
  code: string;
  language: string;
}

/**
 * CodeBlock component with async Shiki highlighting
 * Displays code with line numbers in a CSS grid
 */
const CodeBlock: React.FC<CodeBlockProps> = ({ code, language }) => {
  const [highlightedLines, setHighlightedLines] = useState<string[] | null>(null);
  const { theme: themeMode } = useTheme();

  // Split code into lines, removing trailing empty line
  const plainLines = code
    .split("\n")
    .filter((line, idx, arr) => idx < arr.length - 1 || line !== "");

  useEffect(() => {
    let cancelled = false;
    const shikiTheme = themeMode === "light" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;

    setHighlightedLines(null);

    async function highlight() {
      try {
        const highlighter = await getShikiHighlighter();
        const shikiLang = mapToShikiLang(language);

        // Load language on-demand if not already loaded
        // This is race-safe: concurrent loads of the same language are idempotent
        const loadedLangs = highlighter.getLoadedLanguages();
        if (!loadedLangs.includes(shikiLang)) {
          try {
            // TypeScript doesn't know shikiLang is valid, but we handle errors gracefully
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
            await highlighter.loadLanguage(shikiLang as any);
          } catch {
            // Language not available in Shiki bundle - fall back to plain text
            console.warn(`Language '${shikiLang}' not available in Shiki, using plain text`);
            if (!cancelled) {
              setHighlightedLines(null);
            }
            return;
          }
        }

        const html = highlighter.codeToHtml(code, {
          lang: shikiLang,
          theme: shikiTheme,
        });

        if (!cancelled) {
          const lines = extractShikiLines(html);
          // Remove trailing empty line if present
          const filteredLines = lines.filter(
            (line, idx, arr) => idx < arr.length - 1 || line.trim() !== ""
          );
          setHighlightedLines(filteredLines.length > 0 ? filteredLines : null);
        }
      } catch (error) {
        console.warn(`Failed to highlight code block (${language}):`, error);
        if (!cancelled) setHighlightedLines(null);
      }
    }

    void highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language, themeMode]);

  const lines = highlightedLines ?? plainLines;

  return (
    <div className="code-block-wrapper">
      <div className="code-block-container">
        {lines.map((content, idx) => (
          <React.Fragment key={idx}>
            <div className="line-number">{idx + 1}</div>
            {/* SECURITY AUDIT: dangerouslySetInnerHTML usage
             * Source: Shiki syntax highlighter (highlighter.codeToHtml)
             * Safety: Shiki escapes all user content before wrapping in <span> tokens
             * Data flow: User markdown → react-markdown → code prop → Shiki → extractShikiLines → here
             * Verification: Shiki's codeToHtml tokenizes and escapes HTML entities in code content
             * Risk: Low - Shiki is a trusted library that properly escapes user input
             * Alternative considered: Render Shiki's full <code> block, but per-line rendering
             *   required for line numbers in CSS grid layout
             */}
            <div
              className="code-line"
              {...(highlightedLines
                ? { dangerouslySetInnerHTML: { __html: content } }
                : { children: <code>{content}</code> })}
            />
          </React.Fragment>
        ))}
      </div>
      <CopyButton text={code} className="code-copy-button" />
    </div>
  );
};

// Custom components for markdown rendering
export const markdownComponents = {
  // Pass through pre element - let code component handle the wrapping
  pre: ({ children }: PreProps) => <>{children}</>,

  // Custom anchor to open links externally
  a: ({ href, children }: AnchorProps) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),

  // Custom details/summary for collapsible sections
  details: ({ children, open }: DetailsProps) => (
    <details
      open={open}
      className="bg-code-bg my-2 rounded border border-white/10 px-2 py-1 text-sm"
    >
      {children}
    </details>
  ),

  summary: ({ children }: SummaryProps) => (
    <summary className="cursor-pointer py-1 pl-1 font-semibold select-none">{children}</summary>
  ),

  // Custom code block renderer with async Shiki highlighting
  code: ({ inline, className, children, node, ...props }: CodeProps) => {
    const match = /language-(\w+)/.exec(className ?? "");
    const language = match ? match[1] : "";

    // Extract text content
    const childString =
      typeof children === "string" ? children : Array.isArray(children) ? children.join("") : "";
    const hasMultipleLines = childString.includes("\n");
    const isInline = inline ?? !hasMultipleLines;

    // Handle mermaid diagrams specially
    if (!isInline && language === "mermaid") {
      return <Mermaid chart={childString} />;
    }

    // Code blocks with language - use async Shiki highlighting
    if (!isInline && language) {
      return <CodeBlock code={childString} language={language} />;
    }

    // Code blocks without language (global CSS provides styling)
    if (!isInline) {
      return (
        <pre>
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    }

    // Inline code (filter out node prop to avoid [object Object])
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};
