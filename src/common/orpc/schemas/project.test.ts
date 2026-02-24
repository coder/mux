import { describe, test, expect } from "bun:test";
import { ProjectConfigSchema } from "./project";

describe("ProjectConfigSchema - trusted field", () => {
  test("parses trusted: true", () => {
    const result = ProjectConfigSchema.parse({
      workspaces: [],
      trusted: true,
    });
    expect(result.trusted).toBe(true);
  });

  test("parses trusted: false", () => {
    const result = ProjectConfigSchema.parse({
      workspaces: [],
      trusted: false,
    });
    expect(result.trusted).toBe(false);
  });

  test("trusted defaults to undefined when omitted", () => {
    const result = ProjectConfigSchema.parse({
      workspaces: [],
    });
    expect(result.trusted).toBeUndefined();
  });
});
