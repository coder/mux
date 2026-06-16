/**
 * Shared parser for workflow `export const metadata = { description: "..." }` declarations.
 *
 * Both the runtime workflow scanner (WorkflowDefinitionStore) and the built-in
 * workflow codegen (scripts/gen_builtin_workflows.ts) consume this so the
 * convention cannot drift between build time and runtime. Metadata is parsed
 * statically rather than evaluated: discovery must not run arbitrary top-level
 * workflow code just to read a description.
 */

import {
  parseStaticWorkflowMetadataLiteral,
  replaceStaticMetadataStringProperty,
} from "./staticWorkflowMetadata";

export function parseWorkflowDescription(source: string): string | null {
  let rawMetadata: unknown;
  try {
    rawMetadata = parseStaticWorkflowMetadataLiteral(source);
  } catch {
    return null;
  }
  if (rawMetadata == null || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    return null;
  }
  const description = (rawMetadata as { description?: unknown }).description;
  if (typeof description !== "string") return null;
  const trimmed = description.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function replaceWorkflowDescription(source: string, description: string): string | null {
  return replaceStaticMetadataStringProperty(source, "description", description);
}
