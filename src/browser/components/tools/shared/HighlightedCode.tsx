import React, { useState, useEffect } from "react";
import { highlightCode } from "@/browser/utils/highlighting/highlightWorkerClient";
import { extractShikiLines } from "@/browser/utils/highlighting/shiki-shared";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { cn } from "@/common/lib/utils";

interface HighlightedCodeProps {
  code: string;
  language: string;
  className?: string;
  showLineNumbers?: boolean;
  /** Starting line number (default: 1) */
  startLineNumber?: number;
}

/**
 * Renders code with syntax highlighting using Shiki (via web worker)
 * Falls back to plain text on first render or if highlighting fails
 */
export const HighlightedCode: React.FC<HighlightedCodeProps> = ({
  code,
  language,
  className,
  showLineNumbers = false,
  startLineNumber = 1,
}) => {
  const [highlightedLines, setHighlightedLines] = useState<string[] | null>(null);
  const { theme: themeMode } = useTheme();

  const plainLines = code.split("\n").filter((line, i, arr) => i < arr.length - 1 || line !== "");

  useEffect(() => {
    let cancelled = false;
    const theme = themeMode === "light" || themeMode.endsWith("-light") ? "light" : "dark";

    setHighlightedLines(null);

    async function highlight() {
      try {
        const html = await highlightCode(code, language, theme);
        if (!cancelled) {
          const lines = extractShikiLines(html);
          const filtered = lines.filter((l, i, a) => i < a.length - 1 || l.trim() !== "");
          setHighlightedLines(filtered.length > 0 ? filtered : null);
        }
      } catch (error) {
        console.warn(`Failed to highlight ${language}:`, error);
        if (!cancelled) setHighlightedLines(null);
      }
    }

    void highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language, themeMode]);

  const lines = highlightedLines ?? plainLines;

  if (showLineNumbers) {
    return (
      <div className="code-block-container text-[11px]">
        {lines.map((content, idx) => (
          <React.Fragment key={idx}>
            <div className="line-number">{startLineNumber + idx}</div>
            {/* SECURITY AUDIT: dangerouslySetInnerHTML - Shiki escapes all content */}
            <div
              className="code-line"
              {...(highlightedLines
                ? { dangerouslySetInnerHTML: { __html: content } }
                : { children: content })}
            />
          </React.Fragment>
        ))}
      </div>
    );
  }

  const baseClasses = cn("font-mono text-[11px] leading-relaxed", className);

  if (highlightedLines) {
    return (
      <div
        className={baseClasses}
        dangerouslySetInnerHTML={{ __html: highlightedLines.join("\n") }}
      />
    );
  }
  return <div className={baseClasses}>{code}</div>;
};

interface JsonHighlightProps {
  value: unknown;
  className?: string;
}

/** Renders a value as syntax-highlighted JSON with line numbers */
export const JsonHighlight: React.FC<JsonHighlightProps> = ({ value, className }) => {
  const jsonString = React.useMemo(() => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return value;
      }
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "[Complex Object]";
    }
  }, [value]);

  return (
    <HighlightedCode code={jsonString} language="json" className={className} showLineNumbers />
  );
};
