import { describe, it, expect } from "bun:test";
import { validateWorkspaceName } from "./workspaceValidation";

describe("validateWorkspaceName", () => {
  describe("empty names", () => {
    it("rejects empty string", () => {
      expect(validateWorkspaceName("")).toEqual({
        valid: false,
        error: "Workspace name cannot be empty",
      });
    });
  });

  describe("length validation", () => {
    it("accepts 1 character names", () => {
      expect(validateWorkspaceName("a")).toEqual({ valid: true });
    });

    it("accepts 64 character names", () => {
      const name = "a".repeat(64);
      expect(validateWorkspaceName(name)).toEqual({ valid: true });
    });

    it("rejects 65 character names", () => {
      const name = "a".repeat(65);
      expect(validateWorkspaceName(name)).toEqual({
        valid: false,
        error: "Workspace name cannot exceed 64 characters",
      });
    });

    it("rejects very long names", () => {
      const name = "a".repeat(100);
      expect(validateWorkspaceName(name)).toEqual({
        valid: false,
        error: "Workspace name cannot exceed 64 characters",
      });
    });
  });

  describe("character validation", () => {
    it("accepts lowercase letters", () => {
      expect(validateWorkspaceName("abcdefghijklmnopqrstuvwxyz")).toEqual({ valid: true });
    });

    it("accepts digits", () => {
      expect(validateWorkspaceName("0123456789")).toEqual({ valid: true });
    });

    it("accepts underscores", () => {
      expect(validateWorkspaceName("test_workspace_name")).toEqual({ valid: true });
    });

    it("accepts hyphens", () => {
      expect(validateWorkspaceName("test-workspace-name")).toEqual({ valid: true });
    });

    it("accepts mixed valid characters", () => {
      expect(validateWorkspaceName("feature-branch_123")).toEqual({ valid: true });
      expect(validateWorkspaceName("fix-001")).toEqual({ valid: true });
      expect(validateWorkspaceName("v2_0_1-alpha")).toEqual({ valid: true });
    });

    it("rejects uppercase letters", () => {
      const result = validateWorkspaceName("TestWorkspace");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("lowercase letters");
    });

    it("rejects spaces", () => {
      const result = validateWorkspaceName("test workspace");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("lowercase letters");
    });

    it("rejects special characters", () => {
      const invalidNames = [
        "test!",
        "test@workspace",
        "test#123",
        "test$",
        "test%",
        "test^",
        "test&",
        "test*",
        "test()",
        "test+",
        "test=",
        "test[",
        "test]",
        "test{",
        "test}",
        "test|",
        "test\\",
        "test/",
        "test?",
        "test<",
        "test>",
        "test,",
        "test.",
        "test;",
        "test:",
        "test'",
        'test"',
      ];

      for (const name of invalidNames) {
        const result = validateWorkspaceName(name);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("lowercase letters");
      }
    });
  });

  describe("edge cases", () => {
    it("accepts all hyphens", () => {
      expect(validateWorkspaceName("---")).toEqual({ valid: true });
    });

    it("accepts all underscores", () => {
      expect(validateWorkspaceName("___")).toEqual({ valid: true });
    });

    it("accepts all digits", () => {
      expect(validateWorkspaceName("12345")).toEqual({ valid: true });
    });
  });
});
