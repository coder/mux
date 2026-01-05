import React from "react";
import type { ToolStatus } from "./toolUtils";
import { getToolComponent } from "./getToolComponent";

interface NestedToolRendererProps {
  toolName: string;
  input: unknown;
  output?: unknown;
  status: ToolStatus;
}

/**
 * Routes nested tool calls to their specialized components.
 * Uses the shared registry for component lookup.
 */
export const NestedToolRenderer: React.FC<NestedToolRendererProps> = ({
  toolName,
  input,
  output,
  status,
}) => {
  const ToolComponent = getToolComponent(toolName, input);
  return <ToolComponent args={input} result={output} status={status} toolName={toolName} />;
};
