import { describe, test, expect, beforeAll } from "bun:test";
import { z } from "zod";
import type { Tool } from "ai";
import { validateTypes } from "./typeValidator";
import { generateMuxTypes } from "./typeGenerator";

/**
 * Create a mock tool with the given schema.
 */
function createMockTool(schema: z.ZodType): Tool {
  return {
    description: "Mock tool",
    inputSchema: schema,
    execute: () => Promise.resolve({ success: true }),
  } as unknown as Tool;
}

describe("validateTypes", () => {
  let muxTypes: string;

  // Generate types once for all tests
  beforeAll(async () => {
    const tools = {
      file_read: createMockTool(
        z.object({
          filePath: z.string(),
          offset: z.number().optional(),
          limit: z.number().optional(),
        })
      ),
      bash: createMockTool(
        z.object({
          script: z.string(),
          timeout_secs: z.number(),
          run_in_background: z.boolean(),
          display_name: z.string(),
        })
      ),
    };
    muxTypes = await generateMuxTypes(tools);
  });

  test("accepts valid code with correct property names", () => {
    const result = validateTypes(
      `
      const content = mux.file_read({ filePath: "test.txt" });
      return content.success;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("accepts code using optional properties", () => {
    const result = validateTypes(
      `
      mux.file_read({ filePath: "test.txt", offset: 10, limit: 50 });
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("catches wrong property name", () => {
    const result = validateTypes(
      `
      mux.file_read({ path: "test.txt" });
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    // Error should mention 'path' doesn't exist or 'filePath' is missing
    expect(
      result.errors.some((e) => e.message.includes("path") || e.message.includes("filePath"))
    ).toBe(true);
  });

  test("catches missing required property", () => {
    const result = validateTypes(
      `
      mux.bash({ script: "ls" });
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    // Should error on missing required props
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("catches wrong type for property", () => {
    const result = validateTypes(
      `
      mux.file_read({ filePath: 123 });
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("number") || e.message.includes("string"))
    ).toBe(true);
  });

  test("catches calling non-existent tool", () => {
    const result = validateTypes(
      `
      mux.nonexistent_tool({ foo: "bar" });
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("nonexistent_tool"))).toBe(true);
  });

  test("returns line numbers for type errors", () => {
    const result = validateTypes(
      `const x = 1;
const y = 2;
mux.file_read({ path: "test.txt" });`,
      muxTypes
    );
    expect(result.valid).toBe(false);
    // Error should be on line 3 (the mux.file_read call)
    const errorWithLine = result.errors.find((e) => e.line !== undefined);
    expect(errorWithLine).toBeDefined();
    expect(errorWithLine!.line).toBe(3);
  });

  test("returns line 1 for error on first line", () => {
    const result = validateTypes(`mux.file_read({ path: "test.txt" });`, muxTypes);
    expect(result.valid).toBe(false);
    const errorWithLine = result.errors.find((e) => e.line !== undefined);
    expect(errorWithLine).toBeDefined();
    expect(errorWithLine!.line).toBe(1);
  });

  test("returns correct line for error on last line of multi-line code", () => {
    const result = validateTypes(
      `const a = 1;
const b = 2;
const c = 3;
const d = 4;
mux.file_read({ path: "wrong" });`,
      muxTypes
    );
    expect(result.valid).toBe(false);
    const errorWithLine = result.errors.find((e) => e.line !== undefined);
    expect(errorWithLine).toBeDefined();
    expect(errorWithLine!.line).toBe(5);
  });

  test("returns column number for type errors", () => {
    // Column should point to the problematic property
    const result = validateTypes(`mux.file_read({ path: "test.txt" });`, muxTypes);
    expect(result.valid).toBe(false);
    const errorWithLine = result.errors.find((e) => e.column !== undefined);
    expect(errorWithLine).toBeDefined();
    expect(errorWithLine!.column).toBeGreaterThan(0);
  });

  test("allows dynamic property access (no strict checking on unknown keys)", () => {
    const result = validateTypes(
      `
      const result = mux.file_read({ filePath: "test.txt" });
      const key = "content";
      console.log(result[key]);
    `,
      muxTypes
    );
    // This should pass - we don't enforce strict property checking on results
    expect(result.valid).toBe(true);
  });

  test("allows console.log/warn/error", () => {
    const result = validateTypes(
      `
      console.log("hello");
      console.warn("warning");
      console.error("error");
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("catches syntax error gracefully", () => {
    const result = validateTypes(
      `
      mux.file_read({ filePath: "test.txt" // missing closing brace
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
