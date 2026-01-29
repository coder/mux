import assert from "@/common/utils/assert";
import { z } from "zod";
import { WorkspaceHarnessConfigSchema } from "@/common/orpc/schemas/harness";

/**
 * Prompt-time JSON Schema for `.mux/harness/*.jsonc`.
 *
 * We generate this from the Zod schema (source of truth) at runtime so the
 * model always sees a schema that exactly matches validation.
 */
let cachedHarnessConfigSchemaBlock: string | null = null;

function getHarnessConfigSchemaPromptBlock(): string {
  if (cachedHarnessConfigSchemaBlock) return cachedHarnessConfigSchemaBlock;

  const jsonSchema = z.toJSONSchema(WorkspaceHarnessConfigSchema);
  assert(
    jsonSchema && typeof jsonSchema === "object",
    "Expected z.toJSONSchema(WorkspaceHarnessConfigSchema) to return an object"
  );

  cachedHarnessConfigSchemaBlock = [
    `<harness_config_schema format="jsonschema">`,
    JSON.stringify(jsonSchema, null, 2),
    `</harness_config_schema>`,
  ].join("\n");

  return cachedHarnessConfigSchemaBlock;
}

function normalizeWorkspaceName(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function getHarnessOutputPathPromptBlock(workspaceName: unknown): string | null {
  const normalized = normalizeWorkspaceName(workspaceName);
  if (!normalized) return null;

  return `<harness_output_path>.mux/harness/${normalized}.jsonc</harness_output_path>`;
}

export function maybeAppendHarnessConfigSchemaToAdditionalInstructions(args: {
  agentId: string;
  workspaceName: string | undefined;
  additionalInstructions: string | undefined;
}): string | undefined {
  const shouldInject = args.agentId === "harness-init";
  if (!shouldInject) return args.additionalInstructions;

  const schemaBlock = getHarnessConfigSchemaPromptBlock();
  const outputPathBlock = getHarnessOutputPathPromptBlock(args.workspaceName);
  const block = outputPathBlock ? `${schemaBlock}\n\n${outputPathBlock}` : schemaBlock;

  const additional = args.additionalInstructions;
  if (additional && additional.trim().length > 0) {
    return `${additional}\n\n${block}`;
  }

  return block;
}
