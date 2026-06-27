import { describe, expect, test } from "bun:test";

import { normalizeWorkflowArgsForSource } from "./workflowArgs";

const sourceWithInputSchema = `export const meta = {
  argsSchema: {
    type: "object",
    properties: {
      input: { type: "string" },
      quick: { type: "boolean" }
    },
    required: ["input"]
  }
};
export default function workflow() { return { reportMarkdown: "done" }; }
`;

const sourceWithLegacySchemaOptions = `export const meta = {
  argsSchema: mux.schema.object({
    input: mux.schema.string({ aliases: ["i"], positional: true }),
    quick: mux.schema.boolean({ aliases: ["q"], negatedAliases: ["no-quick"], default: false })
  })
};
export default function workflow() { return { reportMarkdown: "done" }; }
`;

describe("normalizeWorkflowArgsForSource", () => {
  test("treats input as structured data instead of tokenized command text", () => {
    const result = normalizeWorkflowArgsForSource(sourceWithInputSchema, {
      input: "quoted markdown: I'm testing --quick",
    });

    expect(result.args).toEqual({ input: "quoted markdown: I'm testing --quick" });
  });

  test("accepts ignored legacy freeform schema options", () => {
    const result = normalizeWorkflowArgsForSource(sourceWithLegacySchemaOptions, { input: "mux" });

    expect(result.args).toEqual({ input: "mux", quick: false });
  });

  test("does not map raw string args into schema fields", () => {
    expect(() =>
      normalizeWorkflowArgsForSource(sourceWithInputSchema, "review mux --quick")
    ).toThrow("Workflow argument input is required");
  });

  test("still validates required fields", () => {
    expect(() => normalizeWorkflowArgsForSource(sourceWithInputSchema, {})).toThrow(
      "Workflow argument input is required"
    );
  });
});
