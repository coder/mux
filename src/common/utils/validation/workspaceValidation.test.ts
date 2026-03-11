import { validateWorkspaceName, sanitizeWorkspaceNameForPath } from "./workspaceValidation";

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

    test("accepts forward slashes in branch-style names", () => {
      expect(validateWorkspaceName("feature/my-branch").valid).toBe(true);
      expect(validateWorkspaceName("fix/issue-123").valid).toBe(true);
      expect(validateWorkspaceName("user/feature/deep").valid).toBe(true);
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
      expect(result.error).toContain("lowercase");
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
      expect(validateWorkspaceName("branch\\123").valid).toBe(false);
    });

    test("rejects leading slash", () => {
      expect(validateWorkspaceName("/feature").valid).toBe(false);
    });

    test("rejects trailing slash", () => {
      expect(validateWorkspaceName("feature/").valid).toBe(false);
    });

    test("rejects consecutive slashes", () => {
      expect(validateWorkspaceName("feature//branch").valid).toBe(false);
    });

    test("rejects backslashes", () => {
      expect(validateWorkspaceName("path\\to\\branch").valid).toBe(false);
    });
  });
});

describe("sanitizeWorkspaceNameForPath", () => {
  test("returns name unchanged when no slashes", () => {
    expect(sanitizeWorkspaceNameForPath("my-branch")).toBe("my-branch");
  });

  test("replaces single slash with hyphen", () => {
    expect(sanitizeWorkspaceNameForPath("feature/my-branch")).toBe("feature-my-branch");
  });

  test("replaces multiple slashes in deep paths", () => {
    expect(sanitizeWorkspaceNameForPath("user/feature/deep")).toBe("user-feature-deep");
  });

  test("preserves existing consecutive hyphens", () => {
    expect(sanitizeWorkspaceNameForPath("feature--branch")).toBe("feature--branch");
  });

  test("does not collapse hyphens adjacent to replaced slash", () => {
    expect(sanitizeWorkspaceNameForPath("feature/-branch")).toBe("feature--branch");
  });
});
