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
    return parseLegacyWorkflowDescription(source);
  }
  if (rawMetadata != null && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    const description = normalizeDescription(
      (rawMetadata as { description?: unknown }).description
    );
    if (description != null) return description;
  }
  return parseLegacyWorkflowDescription(source);
}

export function replaceWorkflowDescription(source: string, description: string): string | null {
  return (
    replaceStaticMetadataStringProperty(source, "description", description) ??
    replaceLegacyWorkflowDescription(source, description)
  );
}

const LEGACY_DESCRIPTION_HEADER_PATTERN =
  /^(\uFEFF?(?:[ \t]*(?:\r?\n))*[ \t]*)\/\/[ \t]*description:[ \t]*(.*)(?=\r?\n|$)/u;

function parseLegacyWorkflowDescription(source: string): string | null {
  const match = LEGACY_DESCRIPTION_HEADER_PATTERN.exec(source);
  return normalizeDescription(match?.[2]);
}

function replaceLegacyWorkflowDescription(source: string, description: string): string | null {
  const match = LEGACY_DESCRIPTION_HEADER_PATTERN.exec(source);
  if (match == null) return null;
  const prefix = match[1] ?? "";
  return (
    source.slice(0, prefix.length) +
    `// description: ${description}` +
    source.slice(match[0].length)
  );
}

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
