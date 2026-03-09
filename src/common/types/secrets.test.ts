import { describe, expect, it } from "bun:test";
import { isOpReference } from "../utils/opRef";
import { isOpSecretValue } from "./secrets";

describe("isOpSecretValue", () => {
  it("returns true for { op: 'op://...' }", () => {
    expect(isOpSecretValue({ op: "op://Dev/Item/field" })).toBe(true);
  });

  it("returns false for string", () => {
    expect(isOpSecretValue("op://Dev/Item/field")).toBe(false);
  });

  it("returns false for { secret: '...' }", () => {
    expect(isOpSecretValue({ secret: "KEY" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isOpSecretValue(null)).toBe(false);
    expect(isOpSecretValue(undefined)).toBe(false);
  });
});

describe("isOpReference", () => {
  it("returns true for 'op://...' strings", () => {
    expect(isOpReference("op://Dev/Stripe/key")).toBe(true);
  });

  it("returns false for non-op strings", () => {
    expect(isOpReference("sk-12345")).toBe(false);
    expect(isOpReference("")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isOpReference(null)).toBe(false);
    expect(isOpReference(undefined)).toBe(false);
  });
});
