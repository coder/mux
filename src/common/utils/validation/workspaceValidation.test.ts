import { validateWorkspaceName, validateGitBranchName } from "./workspaceValidation";

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

describe("validateGitBranchName", () => {
  describe("valid names", () => {
    test("accepts simple names (same as validateWorkspaceName)", () => {
      expect(validateGitBranchName("main").valid).toBe(true);
      expect(validateGitBranchName("feature").valid).toBe(true);
      expect(validateGitBranchName("my-branch").valid).toBe(true);
      expect(validateGitBranchName("my_branch").valid).toBe(true);
      expect(validateGitBranchName("branch123").valid).toBe(true);
    });

    test("accepts forward slashes (unlike validateWorkspaceName)", () => {
      expect(validateGitBranchName("feature/foo").valid).toBe(true);
      expect(validateGitBranchName("feature/sub/deep").valid).toBe(true);
      expect(validateGitBranchName("bugfix/issue-123").valid).toBe(true);
      expect(validateGitBranchName("release/v1_0").valid).toBe(true); // dots not allowed, use underscore
    });

    test("accepts 64 characters", () => {
      const name = "a".repeat(64);
      expect(validateGitBranchName(name).valid).toBe(true);
    });

    test("accepts 64 characters with slashes", () => {
      // 31 chars + "/" + 32 chars = 64 chars
      const name = "a".repeat(31) + "/" + "b".repeat(32);
      expect(validateGitBranchName(name).valid).toBe(true);
    });
  });

  describe("invalid names", () => {
    test("rejects empty string", () => {
      const result = validateGitBranchName("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("empty");
    });

    test("rejects names over 64 characters", () => {
      const name = "a".repeat(65);
      const result = validateGitBranchName(name);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("64 characters");
    });

    test("rejects leading slash", () => {
      const result = validateGitBranchName("/feature");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("start or end with /");
    });

    test("rejects trailing slash", () => {
      const result = validateGitBranchName("feature/");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("start or end with /");
    });

    test("rejects consecutive slashes", () => {
      const result = validateGitBranchName("feature//foo");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("consecutive slashes");
    });

    test("rejects uppercase letters", () => {
      const result = validateGitBranchName("Feature/Foo");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("a-z");
    });

    test("rejects special characters (except slash)", () => {
      expect(validateGitBranchName("branch@123").valid).toBe(false);
      expect(validateGitBranchName("branch#123").valid).toBe(false);
      expect(validateGitBranchName("branch$123").valid).toBe(false);
      expect(validateGitBranchName("branch%123").valid).toBe(false);
      expect(validateGitBranchName("branch.123").valid).toBe(false);
      expect(validateGitBranchName("branch\\123").valid).toBe(false);
    });
  });
});
