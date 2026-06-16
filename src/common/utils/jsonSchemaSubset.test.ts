import { describe, expect, test } from "bun:test";
import { validateJsonSchemaSubset, validateJsonSchemaSubsetSchema } from "./jsonSchemaSubset";

describe("validateJsonSchemaSubset", () => {
  test("validates schemas without requiring an example value", () => {
    expect(
      validateJsonSchemaSubsetSchema({
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
        additionalProperties: false,
      })
    ).toEqual({ success: true });

    expect(validateJsonSchemaSubsetSchema({ type: ["string", "null"] })).toEqual({
      success: true,
    });
  });

  test("accepts nested objects that satisfy required properties and primitive types", () => {
    const result = validateJsonSchemaSubset(
      {
        type: "object",
        required: ["claims"],
        properties: {
          claims: {
            type: "array",
            items: {
              type: "object",
              required: ["text", "confidence"],
              properties: {
                text: { type: "string" },
                confidence: { type: "number" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      { claims: [{ text: "Workflow runs are durable", confidence: 0.8 }] }
    );

    expect(result).toEqual({ success: true });
  });

  test("returns actionable paths for missing required properties and type errors", () => {
    const result = validateJsonSchemaSubset(
      {
        type: "object",
        required: ["summary", "sources"],
        properties: {
          summary: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
        },
      },
      { sources: ["one", 2] }
    );

    expect(result).toEqual({
      success: false,
      errors: [
        { path: "$.summary", message: "Required property is missing" },
        { path: "$.sources[1]", message: "Expected string, got number" },
      ],
    });
  });

  test("rejects unsupported schema keywords instead of ignoring them", () => {
    const result = validateJsonSchemaSubset({ type: "string", pattern: "^ok$" }, "ok");

    expect(result).toEqual({
      success: false,
      errors: [{ path: "$", message: "Unsupported JSON Schema keyword: pattern" }],
    });
  });

  test("supports JSON Schema type unions", () => {
    expect(validateJsonSchemaSubset({ type: ["string", "null"] }, null)).toEqual({
      success: true,
    });

    expect(validateJsonSchemaSubset({ type: ["string", "null"] }, 42)).toEqual({
      success: false,
      errors: [{ path: "$", message: "Expected string or null, got number" }],
    });
  });

  test("accepts nulls that are included in nullable enums", () => {
    expect(
      validateJsonSchemaSubset({ type: ["string", "null"], enum: ["low", "high", null] }, null)
    ).toEqual({ success: true });
  });

  test("rejects schema-valued additionalProperties instead of ignoring extra values", () => {
    const result = validateJsonSchemaSubset(
      { type: "object", additionalProperties: { type: "string" } },
      { extra: 42 }
    );

    expect(result).toEqual({
      success: false,
      errors: [
        {
          path: "$.additionalProperties",
          message: "Unsupported JSON Schema additionalProperties schema",
        },
      ],
    });
  });

  test("supports enum, integer, and additionalProperties false", () => {
    const result = validateJsonSchemaSubset(
      {
        type: "object",
        properties: {
          status: { enum: ["pass", "fail"] },
          count: { type: "integer" },
        },
        additionalProperties: false,
      },
      { status: "maybe", count: 1.5, extra: true }
    );

    expect(result).toEqual({
      success: false,
      errors: [
        { path: "$.status", message: "Expected one of: pass, fail" },
        { path: "$.count", message: "Expected integer, got number" },
        { path: "$.extra", message: "Additional property is not allowed" },
      ],
    });
  });
});
