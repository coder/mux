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

  test("allows dynamic properties on empty object literals", () => {
    // Claude frequently uses this pattern to collate parallel reads
    const result = validateTypes(
      `
      const results = {};
      results.file1 = mux.file_read({ filePath: "a.txt" });
      results.file2 = mux.file_read({ filePath: "b.txt" });
      return results;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("still catches mux tool typos", () => {
    // Must not filter errors for typos on the mux namespace
    const result = validateTypes(
      `
      mux.file_reade({ filePath: "test.txt" });
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("file_reade"))).toBe(true);
  });

  test("catches reads from empty object literals (typos)", () => {
    // Reads from {} should still error - only writes are allowed
    const result = validateTypes(
      `
      const results = {};
      results.file1 = mux.file_read({ filePath: "a.txt" });
      return results.filee1;  // typo: should be file1
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("filee1"))).toBe(true);
  });

  test("catches empty object properties used in tool args", () => {
    // Using unset properties from {} in tool calls should error
    const result = validateTypes(
      `
      const config = {};
      mux.file_read({ filePath: config.path });  // config.path doesn't exist
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("path"))).toBe(true);
  });

  test("catches empty object reads in expressions", () => {
    // Reading from {} in any expression context should error
    const result = validateTypes(
      `
      const obj = {};
      const x = obj.value + 1;  // obj.value doesn't exist
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("value"))).toBe(true);
  });

  test("catches empty object reads in conditionals", () => {
    const result = validateTypes(
      `
      const obj = {};
      if (obj.flag) { console.log("yes"); }  // obj.flag doesn't exist
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("flag"))).toBe(true);
  });

  test("allows multiple writes to empty object", () => {
    const result = validateTypes(
      `
      const data = {};
      data.a = 1;
      data.b = 2;
      data.c = mux.file_read({ filePath: "test.txt" });
      data.d = "string";
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("catches compound assignment on empty object (+=)", () => {
    // Compound assignments read then write, so should error
    const result = validateTypes(
      `
      const obj = {};
      obj.count += 1;  // reads obj.count first
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("count"))).toBe(true);
  });

  test("accepts ES2021+ features (replaceAll, at, etc.)", () => {
    const result = validateTypes(
      `
      const str = "a-b-c".replaceAll("-", "_");
      const arr = [1, 2, 3];
      const last = arr.at(-1);
      const hasA = Object.hasOwn({ a: 1 }, "a");
      return { str, last, hasA };
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows discriminated union narrowing with negation (!result.success)", () => {
    // This is the idiomatic pattern for handling Result types
    const result = validateTypes(
      `
      const result = mux.file_read({ filePath: "test.txt" });
      if (!result.success) {
        console.log(result.error);  // Should be allowed after narrowing
        return { error: result.error };
      }
      return { content: result.content };
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows discriminated union narrowing with === false", () => {
    const result = validateTypes(
      `
      const result = mux.file_read({ filePath: "test.txt" });
      if (result.success === false) {
        console.log(result.error);
        return null;
      }
      return result.content;
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

  // ==========================================================================
  // Empty array push/unshift patterns (regression tests for never[] fix)
  // ==========================================================================

  test("allows empty array with push pattern", () => {
    // Claude frequently collects results in an empty array
    const result = validateTypes(
      `
      const results = [];
      results.push(mux.file_read({ filePath: "a.txt" }));
      results.push(mux.file_read({ filePath: "b.txt" }));
      return results;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array with unshift pattern", () => {
    const result = validateTypes(
      `
      const results = [];
      results.unshift(mux.file_read({ filePath: "a.txt" }));
      return results;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array with push inside loop", () => {
    const result = validateTypes(
      `
      const files = ["a.txt", "b.txt"];
      const results = [];
      for (const f of files) {
        results.push(mux.file_read({ filePath: f }));
      }
      return results;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows push with primitive values", () => {
    const result = validateTypes(
      `
      const arr = [];
      arr.push(1);
      arr.push("hello");
      arr.push({ foo: "bar" });
      return arr;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Patterns that must continue to work (regression tests)
  // ==========================================================================

  test("allows untyped function parameters", () => {
    const result = validateTypes(
      `
      function process(x) { return x.success; }
      const r = mux.file_read({ filePath: "test.txt" });
      return process(r);
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows untyped arrow function parameters", () => {
    const result = validateTypes(
      `
      const process = (x) => x.success;
      const r = mux.file_read({ filePath: "test.txt" });
      return process(r);
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows destructuring parameters", () => {
    // Test that untyped destructuring params work (no TS7031 error)
    const result = validateTypes(
      `
      function processArgs({ a, b }) { return a + b; }
      return processArgs({ a: 1, b: 2 });
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows rest parameters", () => {
    const result = validateTypes(
      `
      function all(...args) { return args.length; }
      return all(1, 2, 3);
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows callbacks on typed arrays", () => {
    const result = validateTypes(
      `
      const nums = [1, 2, 3];
      const doubled = nums.map(x => x * 2);
      const evens = nums.filter(x => x % 2 === 0);
      nums.forEach(x => console.log(x));
      return { doubled, evens };
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Empty array operations beyond push/unshift (preprocessing tests)
  // These patterns require the preprocessing approach ([] → [] as any[])
  // ==========================================================================

  test("allows map on empty array that gets populated", () => {
    // Preprocessing transforms [] to [] as any[], so operations work
    const result = validateTypes(
      `
      const results = [];
      results.push(mux.file_read({ filePath: "a.txt" }));
      results.push(mux.file_read({ filePath: "b.txt" }));
      return results.map(r => r.success);
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows filter on empty array", () => {
    const result = validateTypes(
      `
      const results = [];
      results.push(mux.file_read({ filePath: "a.txt" }));
      results.push(mux.file_read({ filePath: "b.txt" }));
      return results.filter(r => r.success);
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows forEach on empty array", () => {
    const result = validateTypes(
      `
      const results = [];
      results.push(mux.file_read({ filePath: "a.txt" }));
      results.forEach(r => console.log(r.success));
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows spread of empty array", () => {
    const result = validateTypes(
      `
      const arr = [];
      arr.push(1);
      const copy = [...arr];
      return copy;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows index access on empty array", () => {
    const result = validateTypes(
      `
      const arr = [];
      arr.push("hello");
      return arr[0];
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array in object property", () => {
    const result = validateTypes(
      `
      const obj = { items: [] };
      obj.items.push(1);
      return obj;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array as function argument", () => {
    const result = validateTypes(
      `
      function process(arr) { return arr.length; }
      return process([]);
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("allows empty array in return statement", () => {
    const result = validateTypes(
      `
      function empty() { return []; }
      return empty();
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Empty array literal access patterns (parenthesized assertions)
  // ==========================================================================

  test("handles member access on empty array literal", () => {
    const result = validateTypes(
      `
      const mapped = [].map((x) => x);
      return mapped;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles index access on empty array literal", () => {
    const result = validateTypes(
      `
      const first = [][0];
      return first;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles optional chaining on empty array literal", () => {
    const result = validateTypes(
      `
      const length = []?.length;
      return length;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles property access on empty array literal", () => {
    const result = validateTypes(
      `
      const length = [].length;
      return length;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Multiple arrays and nesting
  // ==========================================================================

  test("handles multiple empty arrays in same statement", () => {
    const result = validateTypes(
      `
      const a = [], b = [];
      a.push(1);
      b.push("hello");
      return { a, b };
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles nested empty arrays", () => {
    const result = validateTypes(
      `
      const matrix = [];
      matrix.push([]);
      matrix[0].push(1);
      return matrix;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Logical expressions with empty arrays
  // ==========================================================================

  test("still fixes empty arrays in logical OR expressions", () => {
    const result = validateTypes(
      `
      const condition = Math.random() > 0.5;
      const maybe = condition ? [] : null;
      const nums = maybe || [1];
      nums.push(2);
      return nums;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("preserves typeof on empty arrays", () => {
    const result = validateTypes(
      `
      const t = typeof [];
      return t.toUpperCase();
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("preserves unary numeric operators on empty arrays", () => {
    const result = validateTypes(
      `
      const value = +[];
      return value;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("preserves void on empty arrays", () => {
    const result = validateTypes(
      `
      const value = void [];
      return value;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("still fixes empty arrays in nullish coalescing expressions", () => {
    const result = validateTypes(
      `
      const condition = Math.random() > 0.5;
      const maybe = condition ? [] : undefined;
      const nums = maybe ?? [1];
      nums.push(2);
      return nums;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  // ==========================================================================
  // Destructuring patterns (valid JS that must not break)
  // ==========================================================================

  test("handles empty array destructuring in for-of LHS", () => {
    // for-of allows destructuring patterns directly in the loop header.
    const result = validateTypes(
      `
      const items = [[1], [2]];
      let count = 0;
      for ([] of items) {
        count += 1;
      }
      return count;
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });

  test("handles empty array destructuring in for-in LHS", () => {
    // for-in does not allow destructuring patterns in TypeScript, but the error
    // should remain about the pattern (not a rewritten `as any[]` assertion).
    const result = validateTypes(
      `
      const obj = { a: 1, b: 2 };
      let count = 0;
      for ([] in obj) {
        count += 1;
      }
      return count;
    `,
      muxTypes
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.message.includes("cannot be a destructuring pattern"))
    ).toBe(true);
    expect(
      result.errors.some((error) => error.message.includes('must be of type "string" or "any"'))
    ).toBe(false);
  });
  test("handles destructuring assignment on LHS", () => {
    // ([] = foo) should not become ([] as any[] = foo) which is invalid
    const result = validateTypes(
      `
      let foo = [1, 2, 3];
      let a, b;
      ([a, b] = foo);
      return [a, b];
    `,
      muxTypes
    );
    expect(result.valid).toBe(true);
  });
});
