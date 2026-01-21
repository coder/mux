import React, { useState } from "react";
import { AlertTriangle, Check, CircleDot, X } from "lucide-react";
import type { ToolErrorResult } from "@/common/types/tools";
import { LoadingDots } from "./ToolPrimitives";

/**
 * Shared utilities and hooks for tool components
 */

export type ToolStatus =
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "interrupted"
  | "backgrounded";

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
          <Check aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">completed</span>
        </>
      );
    case "failed":
      return (
        <>
          <X aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">failed</span>
        </>
      );
    case "interrupted":
      return (
        <>
          <AlertTriangle aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">interrupted</span>
        </>
      );
    case "backgrounded":
      return (
        <>
          <CircleDot aria-hidden="true" className="mr-1 inline-block h-3 w-3 align-[-2px]" />
          <span className="status-text">backgrounded</span>
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

/**
 * Format duration in human-readable form (ms, s, m, h)
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

/**
 * Type guard for ToolErrorResult shape: { success: false, error: string }.
 * Use this when you need type narrowing to access error.
 */
export function isToolErrorResult(val: unknown): val is ToolErrorResult {
  if (!val || typeof val !== "object") return false;
  const record = val as Record<string, unknown>;
  return record.success === false && typeof record.error === "string";
}

/**
 * Determine if a tool output indicates failure.
 * Handles both `{ success: false }` and `{ error: "..." }` shapes.
 * Note: Use isToolErrorResult() when you need type narrowing.
 */
export function isFailedToolOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  if ("success" in output && (output as { success: unknown }).success === false) return true;
  if ("error" in output) return true;
  return false;
}

/**
 * Determine the display status for a nested tool call.
 * - output-available + failure → "failed"
 * - output-available + success → "completed"
 * - input-available + parentInterrupted → "interrupted"
 * - input-available + running → "executing"
 */
export function getNestedToolStatus(
  state: "input-available" | "output-available",
  output: unknown,
  parentInterrupted: boolean
): ToolStatus {
  if (state === "output-available") {
    return isFailedToolOutput(output) ? "failed" : "completed";
  }
  return parentInterrupted ? "interrupted" : "executing";
}
