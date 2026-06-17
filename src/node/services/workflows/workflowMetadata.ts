import type {
  WorkflowDefinitionArgSummary,
  WorkflowDefinitionMetadata,
} from "@/common/types/workflow";
import { WorkflowDefinitionArgSummarySchema } from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";
import { isPlainObject } from "@/common/utils/isPlainObject";
import {
  parseLegacyWorkflowDescription,
  parseWorkflowMetadataDescription,
} from "./workflowDescription";
import { parseStaticWorkflowMetadataLiteral } from "./staticWorkflowMetadata";

export interface WorkflowDefinitionSourceStats {
  chars: number;
  lines: number;
}

export interface WorkflowDefinitionMetadataSummary {
  metadata: WorkflowDefinitionMetadata;
  args?: WorkflowDefinitionArgSummary[];
  sourceStats: WorkflowDefinitionSourceStats;
}

export interface WorkflowDefinitionSourceSummary {
  description: string | null;
  metadataSummary: WorkflowDefinitionMetadataSummary | null;
}

export function parseWorkflowDefinitionMetadata(source: string): WorkflowDefinitionMetadata | null {
  let rawMetadata: unknown;
  try {
    rawMetadata = parseStaticWorkflowMetadataLiteral(source);
  } catch {
    return null;
  }
  if (!isPlainObject(rawMetadata)) {
    return null;
  }
  return rawMetadata;
}

export function summarizeWorkflowDefinitionSource(
  source: string,
  fallbackDescription?: string
): WorkflowDefinitionSourceSummary {
  assert(
    fallbackDescription == null || fallbackDescription.trim().length > 0,
    "Workflow metadata fallback description must be non-empty when provided"
  );
  const parsedMetadata = parseWorkflowDefinitionMetadata(source);
  const metadataDescription =
    parsedMetadata == null ? null : parseWorkflowMetadataDescription(parsedMetadata);
  const description =
    metadataDescription ?? parseLegacyWorkflowDescription(source) ?? fallbackDescription ?? null;
  const metadata =
    description == null
      ? null
      : metadataForDescription(parsedMetadata, description, metadataDescription != null);

  return {
    description,
    metadataSummary: metadata == null ? null : metadataSummaryForSource(source, metadata),
  };
}

export function summarizeWorkflowArgs(
  metadata: WorkflowDefinitionMetadata | null
): WorkflowDefinitionArgSummary[] | undefined {
  const argsSchema = metadata?.argsSchema;
  if (!isPlainObject(argsSchema) || argsSchema.type !== "object") {
    return undefined;
  }
  const rawProperties = argsSchema.properties;
  if (!isPlainObject(rawProperties)) {
    return undefined;
  }

  const required = new Set(nonEmptyStringArray(argsSchema.required));
  const summaries = Object.entries(rawProperties)
    .map(([name, rawProperty]) => summarizeWorkflowArg(name, rawProperty, required))
    .filter((summary): summary is WorkflowDefinitionArgSummary => summary != null);
  return summaries.length > 0 ? summaries : undefined;
}

function metadataForDescription(
  parsedMetadata: WorkflowDefinitionMetadata | null,
  description: string,
  metadataHasDescription: boolean
): WorkflowDefinitionMetadata {
  if (parsedMetadata != null) {
    return !metadataHasDescription ? { ...parsedMetadata, description } : parsedMetadata;
  }
  return { description };
}

function metadataSummaryForSource(
  source: string,
  metadata: WorkflowDefinitionMetadata
): WorkflowDefinitionMetadataSummary {
  const args = summarizeWorkflowArgs(metadata);
  return {
    metadata,
    ...(args != null ? { args } : {}),
    sourceStats: workflowSourceStats(source),
  };
}

function workflowSourceStats(source: string): WorkflowDefinitionSourceStats {
  return {
    chars: source.length,
    lines: source.length === 0 ? 0 : source.split(/\r\n|\r|\n/u).length,
  };
}

function summarizeWorkflowArg(
  name: string,
  rawProperty: unknown,
  required: ReadonlySet<string>
): WorkflowDefinitionArgSummary | null {
  if (!isPlainObject(rawProperty)) {
    return null;
  }
  const summary: WorkflowDefinitionArgSummary = {
    name,
    types: schemaTypes(rawProperty.type),
    required: required.has(name),
  };

  const aliases = nonEmptyStringArray(rawProperty.aliases);
  if (aliases.length > 0) summary.aliases = aliases;

  const negatedAliases = nonEmptyStringArray(rawProperty.negatedAliases);
  if (negatedAliases.length > 0) summary.negatedAliases = negatedAliases;

  if (rawProperty.positional === true) summary.positional = true;
  if (Object.prototype.hasOwnProperty.call(rawProperty, "default")) {
    summary.default = rawProperty.default;
  }

  const enumValues = Array.isArray(rawProperty.enum) ? rawProperty.enum : [];
  if (enumValues.length > 0) summary.enum = enumValues;

  if (typeof rawProperty.minimum === "number" && Number.isFinite(rawProperty.minimum)) {
    summary.minimum = rawProperty.minimum;
  }
  if (typeof rawProperty.maximum === "number" && Number.isFinite(rawProperty.maximum)) {
    summary.maximum = rawProperty.maximum;
  }

  return WorkflowDefinitionArgSummarySchema.parse(summary);
}

function schemaTypes(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  if (Array.isArray(value)) {
    const types = nonEmptyStringArray(value);
    return types.length > 0 ? Array.from(new Set(types)) : ["unknown"];
  }
  return ["unknown"];
}

function nonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
