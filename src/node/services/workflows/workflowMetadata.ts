import type {
  WorkflowDefinitionArgSummary,
  WorkflowDefinitionMetadata,
} from "@/common/types/workflow";
import { WorkflowDefinitionArgSummarySchema } from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { parseStaticWorkflowMetadataLiteral } from "./staticWorkflowMetadata";

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

export function workflowDefinitionMetadataForSource(
  source: string,
  fallbackDescription: string
): WorkflowDefinitionMetadata {
  assert(
    fallbackDescription.trim().length > 0,
    "Workflow metadata fallback description is required"
  );
  const metadata = parseWorkflowDefinitionMetadata(source);
  if (metadata != null) {
    return typeof metadata.description === "string"
      ? metadata
      : { ...metadata, description: fallbackDescription };
  }
  // Legacy `// description:` workflows have no static metadata object. Return a
  // tiny synthetic metadata object so the tool still gives agents the useful
  // descriptor-level description without sending implementation source.
  return { description: fallbackDescription };
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

  const required = new Set(requiredArgNames(argsSchema.required));
  const summaries = Object.entries(rawProperties)
    .map(([name, rawProperty]) => summarizeWorkflowArg(name, rawProperty, required))
    .filter((summary): summary is WorkflowDefinitionArgSummary => summary != null);
  return summaries.length > 0 ? summaries : undefined;
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

  const aliases = stringArray(rawProperty.aliases);
  if (aliases.length > 0) summary.aliases = aliases;

  const negatedAliases = stringArray(rawProperty.negatedAliases);
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

function requiredArgNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function schemaTypes(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  if (Array.isArray(value)) {
    const types = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0
    );
    return types.length > 0 ? Array.from(new Set(types)) : ["unknown"];
  }
  return ["unknown"];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
