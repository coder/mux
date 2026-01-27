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

export function maybeAppendHarnessConfigSchemaToAdditionalInstructions(args: {
  agentId: string;
  additionalInstructions: string | undefined;
}): string | undefined {
  const shouldInject = args.agentId === "harness-init" || args.agentId === "harness-from-plan";
  if (!shouldInject) return args.additionalInstructions;

  const block = getHarnessConfigSchemaPromptBlock();
  const additional = args.additionalInstructions;
  if (additional && additional.trim().length > 0) {
    return `${additional}\n\n${block}`;
  }

  return block;
}
