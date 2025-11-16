import React, { useState } from "react";
import { LoadingDots } from "./ToolPrimitives";

/**
 * Shared utilities and hooks for tool components
 */

export type ToolStatus = "pending" | "executing" | "completed" | "failed" | "interrupted";

/**
 * Hook for managing tool expansion state
 */
export function useToolExpansion(initialExpanded = false) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const toggleExpanded = () => setExpanded(!expanded);
  return { expanded, setExpanded, toggleExpanded };
}

/**
 * Get display element for tool status
 */
export function getStatusDisplay(status: ToolStatus): React.ReactNode {
  switch (status) {
    case "executing":
      return (
        <>
          <LoadingDots /> <span className="status-text">executing</span>
        </>
      );
    case "completed":
      return (
        <>
          ✓<span className="status-text"> completed</span>
        </>
      );
    case "failed":
      return (
        <>
          ✗<span className="status-text"> failed</span>
        </>
      );
    case "interrupted":
      return (
        <>
          ⚠<span className="status-text"> interrupted</span>
        </>
      );
    default:
      return <span className="status-text">pending</span>;
  }
}

/**
 * Format a value for display (JSON or string)
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // If JSON.stringify fails (e.g., circular reference), return a safe fallback
    return "[Complex Object - Cannot Stringify]";
  }
}
