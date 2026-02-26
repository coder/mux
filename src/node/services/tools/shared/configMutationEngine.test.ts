import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { applyMutations } from "./configMutationEngine";

const TestSchema = z
  .object({
    name: z.string().optional(),
    nested: z
      .object({
        value: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

describe("applyMutations", () => {
  it("applies set operation", () => {
    const result = applyMutations({}, [{ op: "set", path: ["name"], value: "test" }], TestSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document).toEqual({ name: "test" });
    }
  });

  it("applies delete operation", () => {
    const result = applyMutations({ name: "test" }, [{ op: "delete", path: ["name"] }], TestSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document).toEqual({});
    }
  });

  it("applies nested set operation", () => {
    const result = applyMutations(
      {},
      [{ op: "set", path: ["nested", "value"], value: 42 }],
      TestSchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document).toEqual({ nested: { value: 42 } });
    }
  });

  it("rejects __proto__ path segment", () => {
    const result = applyMutations(
      {},
      [{ op: "set", path: ["__proto__", "polluted"], value: true }],
      TestSchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("__proto__");
    }
  });

  it("rejects prototype path segment", () => {
    const result = applyMutations({}, [{ op: "set", path: ["prototype"], value: {} }], TestSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("prototype");
    }
  });

  it("rejects constructor path segment", () => {
    const result = applyMutations(
      {},
      [{ op: "set", path: ["constructor"], value: {} }],
      TestSchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("constructor");
    }
  });

  it("returns validation issues on schema failure", () => {
    const strictSchema = z.object({ name: z.string() }).strict();
    const result = applyMutations({}, [{ op: "set", path: ["invalid"], value: "x" }], strictSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.validationIssues).toBeDefined();
      expect(result.validationIssues?.length).toBeGreaterThan(0);
    }
  });

  it("applies multiple operations in sequence", () => {
    const result = applyMutations(
      {},
      [
        { op: "set", path: ["name"], value: "test" },
        { op: "set", path: ["nested", "value"], value: 42 },
      ],
      TestSchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document).toEqual({ name: "test", nested: { value: 42 } });
      expect(result.appliedOps).toBe(2);
    }
  });

  it("preserves unknown fields in nested non-passthrough schemas", () => {
    const result = applyMutations(
      {
        name: "original",
        nested: { value: 1, futureField: "keep-me" },
        topExtra: 99,
      },
      [{ op: "set", path: ["name"], value: "updated" }],
      TestSchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document as unknown).toEqual({
        name: "updated",
        nested: { value: 1, futureField: "keep-me" },
        topExtra: 99,
      });
    }
  });

  it("rejects oversized array index in set operation", () => {
    const ArraySchema = z.object({ items: z.array(z.string()).optional() }).passthrough();
    const result = applyMutations(
      { items: ["a"] },
      [{ op: "set", path: ["items", "4000000000"], value: "boom" }],
      ArraySchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("exceeds maximum");
    }
  });

  it("rejects oversized array index in intermediate traversal", () => {
    const ArraySchema = z
      .object({ items: z.array(z.object({ v: z.number() })).optional() })
      .passthrough();
    const result = applyMutations(
      { items: [{ v: 1 }] },
      [{ op: "set", path: ["items", "999999999", "v"], value: 2 }],
      ArraySchema
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("exceeds maximum");
    }
  });

  it("creates object (not array) for numeric-looking keys under object parents", () => {
    const RecordSchema = z
      .object({
        settings: z.record(z.string(), z.object({ value: z.string().optional() })).optional(),
      })
      .passthrough();

    const result = applyMutations(
      {},
      [{ op: "set", path: ["settings", "123", "value"], value: "hello" }],
      RecordSchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document).toEqual({ settings: { "123": { value: "hello" } } });
      // The intermediate "123" must be an object, not an array
      const settings = (result.document as Record<string, unknown>).settings as Record<
        string,
        unknown
      >;
      expect(Array.isArray(settings["123"])).toBe(false);
    }
  });

  it("set traversal treats inherited property names as missing keys", () => {
    const InheritedKeySchema = z
      .object({ toString: z.object({ value: z.number() }).optional() })
      .passthrough();

    const result = applyMutations(
      {},
      [{ op: "set", path: ["toString", "value"], value: 1 }],
      InheritedKeySchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document).toEqual({ toString: { value: 1 } });
    }
  });

  it("delete treats inherited property names (toString) as missing", () => {
    const result = applyMutations(
      { name: "test" },
      [{ op: "delete", path: ["toString"] }],
      TestSchema
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document).toEqual({ name: "test" });
    }
  });
});
