import { describe, expect, it } from "bun:test";
import { WORKSPACE_NAME_MAX_LENGTH } from "@/constants/workspaceNaming";
import { resolveWorkspaceName } from "./workspaceNameResolver";

describe("workspaceNameResolver", () => {
  it("should reject invalid workspace names", () => {
    const result = resolveWorkspaceName("Invalid-Name", new Set(), { type: "error" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Use only");
    }
  });

  it("should return the requested name when no collision exists", () => {
    const result = resolveWorkspaceName("valid-name", new Set(), { type: "error" });
    expect(result).toEqual({ success: true, data: { name: "valid-name" } });
  });

  it("should error on collisions when using error strategy", () => {
    const result = resolveWorkspaceName("existing", new Set(["existing"]), { type: "error" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("already exists");
    }
  });

  it("should generate numeric suffix for forks", () => {
    const result = resolveWorkspaceName("feature", new Set(["feature", "feature-2"]), {
      type: "numeric-suffix",
    });
    expect(result).toEqual({ success: true, data: { name: "feature-3", suffix: 3 } });
  });

  it("should generate random suffix within length limits", () => {
    const base = "a".repeat(WORKSPACE_NAME_MAX_LENGTH);
    const existingNames = new Set([base]);
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.123456;
      const result = resolveWorkspaceName(base, existingNames, {
        type: "random-suffix",
        maxAttempts: 1,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.name.length).toBe(WORKSPACE_NAME_MAX_LENGTH);
      expect(result.data.name.endsWith("-4fzy")).toBe(true);
    } finally {
      Math.random = originalRandom;
    }
  });
});
