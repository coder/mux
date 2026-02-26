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
});
