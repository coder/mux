import { validateWorkspaceName } from "./workspaceValidation";

describe("validateWorkspaceName", () => {
  describe("valid names", () => {
    test("accepts lowercase letters", () => {
      expect(validateWorkspaceName("main").valid).toBe(true);
      expect(validateWorkspaceName("feature").valid).toBe(true);
    });

    test("accepts digits", () => {
      expect(validateWorkspaceName("branch123").valid).toBe(true);
      expect(validateWorkspaceName("123").valid).toBe(true);
    });

    test("accepts underscores", () => {
      expect(validateWorkspaceName("my_branch").valid).toBe(true);
      expect(validateWorkspaceName("feature_test_123").valid).toBe(true);
    });

    test("accepts hyphens", () => {
      expect(validateWorkspaceName("my-branch").valid).toBe(true);
      expect(validateWorkspaceName("feature-test-123").valid).toBe(true);
    });

    test("accepts combinations", () => {
      expect(validateWorkspaceName("feature-branch_123").valid).toBe(true);
      expect(validateWorkspaceName("a1-b2_c3").valid).toBe(true);
    });

    test("accepts single character", () => {
      expect(validateWorkspaceName("a").valid).toBe(true);
      expect(validateWorkspaceName("1").valid).toBe(true);
      expect(validateWorkspaceName("_").valid).toBe(true);
      expect(validateWorkspaceName("-").valid).toBe(true);
    });

    test("accepts 64 characters", () => {
      const name = "a".repeat(64);
      expect(validateWorkspaceName(name).valid).toBe(true);
    });
  });

  describe("invalid names", () => {
    test("rejects empty string", () => {
      const result = validateWorkspaceName("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("empty");
    });

    test("rejects names over 64 characters", () => {
      const name = "a".repeat(65);
      const result = validateWorkspaceName(name);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("64 characters");
    });

    test("rejects uppercase letters", () => {
      const result = validateWorkspaceName("MyBranch");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("a-z");
    });

    test("rejects spaces", () => {
      const result = validateWorkspaceName("my branch");
      expect(result.valid).toBe(false);
    });

    test("rejects special characters", () => {
      expect(validateWorkspaceName("branch@123").valid).toBe(false);
      expect(validateWorkspaceName("branch#123").valid).toBe(false);
      expect(validateWorkspaceName("branch$123").valid).toBe(false);
      expect(validateWorkspaceName("branch%123").valid).toBe(false);
      expect(validateWorkspaceName("branch!123").valid).toBe(false);
      expect(validateWorkspaceName("branch.123").valid).toBe(false);
      expect(validateWorkspaceName("branch/123").valid).toBe(false);
      expect(validateWorkspaceName("branch\\123").valid).toBe(false);
    });

    test("rejects names with slashes", () => {
      expect(validateWorkspaceName("feature/branch").valid).toBe(false);
      expect(validateWorkspaceName("path\\to\\branch").valid).toBe(false);
    });
  });
});
