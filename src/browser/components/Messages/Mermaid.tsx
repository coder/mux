import type { CSSProperties, ReactNode } from "react";
import React, { useContext, useEffect, useRef, useState } from "react";
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
  securityLevel: "loose",
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
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
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
    let id: string | undefined;

    const renderDiagram = async () => {
      id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
      try {
        setError(null);

        // Parse first to validate syntax without rendering
        await mermaid.parse(chart);

        // If parse succeeds, render the diagram
        const { svg: renderedSvg } = await mermaid.render(id, chart);
        setSvg(renderedSvg);
        if (containerRef.current) {
          containerRef.current.innerHTML = renderedSvg;
        }
      } catch (err) {
        // Clean up any DOM elements mermaid might have created with our ID
        const errorElement = document.getElementById(id);
        if (errorElement) {
          errorElement.remove();
        }

        setError(err instanceof Error ? err.message : "Failed to render diagram");
        setSvg(""); // Clear any previous SVG
        if (containerRef.current) {
          containerRef.current.innerHTML = ""; // Clear the container
        }
      }
    };

    void renderDiagram();

    // Cleanup on unmount or when chart changes
    return () => {
      if (id) {
        const element = document.getElementById(id);
        if (element) {
          element.remove();
        }
      }
    };
  }, [chart]);

  // Update modal container when opened
  useEffect(() => {
    if (isModalOpen && modalContainerRef.current && svg) {
      modalContainerRef.current.innerHTML = svg;
    }
  }, [isModalOpen, svg]);

  // During streaming, show placeholder instead of error
  if (error) {
    if (isStreaming) {
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
    }

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
