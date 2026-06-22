/**
 * Shared parser for workflow `export const meta = { description: "..." }` declarations.
 *
 * Workflow display helpers consume this so the description convention cannot drift.
 * Metadata is parsed
 * statically rather than evaluated: discovery must not run arbitrary top-level
 * workflow code just to read a description.
 */

import {
  parseStaticWorkflowMetadataLiteral,
  replaceStaticMetadataStringProperty,
} from "./staticWorkflowMetadata";

export function parseWorkflowDescription(source: string): string | null {
  try {
    return parseWorkflowMetadataDescription(parseStaticWorkflowMetadataLiteral(source));
  } catch {
    return null;
  }
}

export function parseWorkflowName(source: string): string | null {
  try {
    return parseWorkflowMetadataName(parseStaticWorkflowMetadataLiteral(source));
  } catch {
    return null;
  }
}

export function parseWorkflowMetadataName(rawMetadata: unknown): string | null {
  if (rawMetadata != null && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    return normalizeDescription((rawMetadata as { name?: unknown }).name);
  }
  return null;
}

export function parseWorkflowMetadataDescription(rawMetadata: unknown): string | null {
  if (rawMetadata != null && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    return normalizeDescription((rawMetadata as { description?: unknown }).description);
  }
  return null;
}

export function replaceWorkflowDescription(source: string, description: string): string | null {
  return replaceStaticMetadataStringProperty(source, "description", description);
}

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
