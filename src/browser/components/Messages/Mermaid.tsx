import type { CSSProperties, ReactNode } from "react";
import React, { useContext, useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";
import { StreamingContext } from "./StreamingContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";

const MIN_HEIGHT = 300;
const MAX_HEIGHT = 1200;

// Initialize mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  layout: "elk",
  // Security hardening: Mermaid content is untrusted (comes from markdown),
  // so keep Mermaid's strict sanitization and disallow scriptable links.
  securityLevel: "strict",
  fontFamily: "var(--font-monospace)",
  darkMode: true,
  elk: {
    nodePlacementStrategy: "LINEAR_SEGMENTS",
    mergeEdges: true,
  },
  wrap: true,
  markdownAutoWrap: true,
  flowchart: {
    nodeSpacing: 60,
    curve: "linear",
    defaultRenderer: "elk",
  },
});

function decodeNumericCodePoint(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    // Treat invalid numeric entities as empty content to avoid parser crashes
    // and collapse obfuscated scheme separators.
    return "";
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function decodeEntity(entityBody: string): string | null {
  if (entityBody.startsWith("#x") || entityBody.startsWith("#X")) {
    const parsed = Number.parseInt(entityBody.slice(2), 16);
    return Number.isNaN(parsed) ? "" : decodeNumericCodePoint(parsed);
  }

  if (entityBody.startsWith("#")) {
    const parsed = Number.parseInt(entityBody.slice(1), 10);
    return Number.isNaN(parsed) ? "" : decodeNumericCodePoint(parsed);
  }

  const named: Record<string, string> = {
    tab: "\t",
    newline: "\n",
    colon: ":",
    nbsp: " ",
  };

  return named[entityBody.toLowerCase()] ?? null;
}

function canonicalizeUrlForSchemeCheck(value: string): string {
  // Normalize encoded and obfuscated schemes before comparison so payloads like
  // java&#10;script:, java%0Ascript:, or java\nscript: reduce to javascript:.
  let normalized = value.toLowerCase();

  normalized = normalized.replace(/&([^;\s]+);?/g, (fullMatch, entityBody: string) => {
    return decodeEntity(entityBody) ?? fullMatch;
  });

  normalized = normalized.replace(/%([0-9a-f]{2})/gi, (fullMatch, hex: string) => {
    const parsed = Number.parseInt(hex, 16);
    return Number.isNaN(parsed) ? fullMatch : String.fromCodePoint(parsed);
  });

  let canonical = "";
  for (const char of normalized) {
    const charCode = char.charCodeAt(0);
    const isAsciiControl = charCode <= 0x1f || charCode === 0x7f;
    if (isAsciiControl || /\s/.test(char)) {
      continue;
    }

    canonical += char;
  }

  return canonical;
}

export function sanitizeMermaidSvg(svg: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, "image/svg+xml");

  if (doc.querySelector("parsererror")) {
    return null;
  }

  const svgRoot = doc.documentElement;
  if (svgRoot.tagName.toLowerCase() !== "svg") {
    return null;
  }

  // Defense in depth: remove active content containers and sanitize remaining attributes.
  // NOTE: Keep <foreignObject> because Mermaid uses it for wrapped node labels.
  doc.querySelectorAll("script,iframe,object,embed").forEach((node) => {
    node.remove();
  });

  const urlAttributes = new Set(["href", "xlink:href", "src", "action", "formaction"]);
  const blockedSchemes = ["javascript:", "vbscript:", "data:text/html"];

  doc.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const canonicalUrlValue = canonicalizeUrlForSchemeCheck(attribute.value.trim());

      if (attributeName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (
        urlAttributes.has(attributeName) &&
        blockedSchemes.some((scheme) => canonicalUrlValue.startsWith(scheme))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  return svgRoot.outerHTML;
}

// Common button styles
const getButtonStyle = (disabled = false): CSSProperties => ({
  background: disabled ? "rgba(255, 255, 255, 0.05)" : "rgba(255, 255, 255, 0.1)",
  border: "1px solid rgba(255, 255, 255, 0.2)",
  color: disabled ? "var(--color-text-secondary)" : "var(--color-text)",
  padding: "6px 10px",
  cursor: disabled ? "not-allowed" : "pointer",
  borderRadius: "4px",
  fontSize: "16px",
  lineHeight: 1,
  opacity: disabled ? 0.5 : 1,
});

// Modal component for fullscreen diagram view
const DiagramModal: React.FC<{ children: ReactNode; onClose: () => void }> = ({
  children,
  onClose,
}) => {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleEscape, { capture: true });
    return () => window.removeEventListener("keydown", handleEscape, { capture: true });
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.9)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: "relative",
          maxWidth: "90%",
          maxHeight: "90%",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            background: "rgba(255, 255, 255, 0.1)",
            border: "1px solid rgba(255, 255, 255, 0.2)",
            color: "var(--color-text)",
            padding: "8px 16px",
            cursor: "pointer",
            borderRadius: "4px",
            fontSize: "14px",
            fontFamily: "var(--font-primary)",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
};

// Mermaid diagram component
export const Mermaid: React.FC<{ chart: string }> = ({ chart }) => {
  const { isStreaming } = useContext(StreamingContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const modalContainerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [svg, setSvg] = useState<string>("");
  const lastValidSvgRef = useRef<string>("");
  const stableId = useId();

  // Debounce chart changes to avoid flickering during streaming
  const [debouncedChart, setDebouncedChart] = useState(chart);
  useEffect(() => {
    // Clear stale errors when chart changes - avoids error flash at end of stream
    setError(null);
    const timer = setTimeout(() => setDebouncedChart(chart), 350);
    return () => clearTimeout(timer);
  }, [chart]);

  const [diagramMaxHeight, setDiagramMaxHeight] = usePersistedState(
    "mermaid-diagram-max-height",
    MIN_HEIGHT,
    { listener: true }
  );

  const atMinHeight = diagramMaxHeight <= MIN_HEIGHT;
  const atMaxHeight = diagramMaxHeight >= MAX_HEIGHT;

  const handleIncreaseHeight = () => {
    if (!atMaxHeight) {
      setDiagramMaxHeight((prev) => Math.min(MAX_HEIGHT, Math.round(prev * 1.1)));
    }
  };

  const handleDecreaseHeight = () => {
    if (!atMinHeight) {
      setDiagramMaxHeight((prev) => Math.max(MIN_HEIGHT, Math.round(prev * 0.9)));
    }
  };

  useEffect(() => {
    // Use stable ID to avoid ELK layout recalculating from scratch each render
    const id = `mermaid-${stableId.replace(/:/g, "")}`;
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        // Parse first to validate syntax without rendering
        await mermaid.parse(debouncedChart);

        // If parse succeeds, render the diagram
        const { svg: renderedSvg } = await mermaid.render(id, debouncedChart);
        if (cancelled) return;

        const sanitizedSvg = sanitizeMermaidSvg(renderedSvg);
        if (!sanitizedSvg) {
          throw new Error("Mermaid returned invalid SVG output");
        }

        lastValidSvgRef.current = sanitizedSvg;
        setSvg(sanitizedSvg);
        setError(null);
        if (containerRef.current) {
          // SECURITY AUDIT: sanitizedSvg is produced by sanitizeMermaidSvg(),
          // which strips active SVG/HTML content before insertion.
          containerRef.current.innerHTML = sanitizedSvg;
        }
      } catch (err) {
        if (cancelled) return;

        // Don't remove elements by ID - with stable IDs, we'd remove the last valid render
        // Mermaid error artifacts are cleaned up by subsequent successful renders

        setError(err instanceof Error ? err.message : "Failed to render diagram");
        // Don't clear SVG - keep showing last valid render during errors
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [debouncedChart, stableId]);

  // Update modal container when opened
  useEffect(() => {
    if (isModalOpen && modalContainerRef.current && svg) {
      // SECURITY AUDIT: svg state only stores sanitizeMermaidSvg() output.
      modalContainerRef.current.innerHTML = svg;
    }
  }, [isModalOpen, svg]);

  // During streaming errors, show last valid SVG if available, otherwise placeholder
  if (error) {
    if (isStreaming && lastValidSvgRef.current) {
      // Keep showing last valid render while streaming
      // Fall through to render the container with lastValidSvgRef content
    } else if (isStreaming) {
      return (
        <div
          style={{
            color: "var(--color-text-secondary)",
            background: "var(--color-code-bg)",
            padding: "12px",
            fontStyle: "italic",
          }}
        >
          Rendering diagram...
        </div>
      );
    } else {
      // Not streaming - show actual error
      return (
        <pre
          style={{
            color: "var(--color-syntax-error)",
            background: "hsl(from var(--color-syntax-error) h s l / 0.1)",
            padding: "12px",
          }}
        >
          Mermaid Error: {error}
        </pre>
      );
    }
  }

  return (
    <>
      <div
        style={{
          position: "relative",
          margin: "1em 0",
          background: "var(--color-code-bg)",
          borderRadius: "4px",
          padding: "16px",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            display: "flex",
            gap: "4px",
          }}
        >
          <button
            onClick={handleDecreaseHeight}
            disabled={atMinHeight}
            style={getButtonStyle(atMinHeight)}
            title="Decrease diagram height"
          >
            −
          </button>
          <button
            onClick={handleIncreaseHeight}
            disabled={atMaxHeight}
            style={getButtonStyle(atMaxHeight)}
            title="Increase diagram height"
          >
            +
          </button>
          <button
            onClick={() => setIsModalOpen(true)}
            style={getButtonStyle()}
            title="Expand diagram"
          >
            ⤢
          </button>
        </div>
        <div
          ref={containerRef}
          className="mermaid-container"
          style={{
            maxWidth: "70%",
            margin: "0 auto",
            ["--diagram-max-height" as string]: `${diagramMaxHeight}px`,
          }}
        />
      </div>
      {isModalOpen && (
        <DiagramModal onClose={() => setIsModalOpen(false)}>
          <div
            ref={modalContainerRef}
            className="mermaid-container mermaid-modal"
            style={{
              background: "var(--color-code-bg)",
              padding: "24px",
              borderRadius: "8px",
              minWidth: "80vw",
              minHeight: "60vh",
            }}
          />
        </DiagramModal>
      )}
    </>
  );
};
