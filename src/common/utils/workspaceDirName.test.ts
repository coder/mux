import { encodeWorkspaceNameForDir, decodeWorkspaceNameFromDir } from "./workspaceDirName";

describe("encodeWorkspaceNameForDir", () => {
  test("leaves simple names unchanged", () => {
    expect(encodeWorkspaceNameForDir("main")).toBe("main");
    expect(encodeWorkspaceNameForDir("feature")).toBe("feature");
    expect(encodeWorkspaceNameForDir("my-branch")).toBe("my-branch");
    expect(encodeWorkspaceNameForDir("my_branch")).toBe("my_branch");
    expect(encodeWorkspaceNameForDir("branch123")).toBe("branch123");
  });

  test("encodes forward slashes", () => {
    expect(encodeWorkspaceNameForDir("feature/foo")).toBe("feature%2Ffoo");
    expect(encodeWorkspaceNameForDir("feature/sub/deep")).toBe("feature%2Fsub%2Fdeep");
  });

  test("encodes other special characters", () => {
    // These are less common but encodeURIComponent handles them
    expect(encodeWorkspaceNameForDir("test@branch")).toBe("test%40branch");
    expect(encodeWorkspaceNameForDir("test#branch")).toBe("test%23branch");
  });
});

describe("decodeWorkspaceNameFromDir", () => {
  test("decodes encoded names back to original", () => {
    expect(decodeWorkspaceNameFromDir("feature%2Ffoo")).toBe("feature/foo");
    expect(decodeWorkspaceNameFromDir("feature%2Fsub%2Fdeep")).toBe("feature/sub/deep");
  });

  test("leaves unencoded names unchanged", () => {
    expect(decodeWorkspaceNameFromDir("main")).toBe("main");
    expect(decodeWorkspaceNameFromDir("my-branch")).toBe("my-branch");
  });

  test("roundtrip: encode then decode returns original", () => {
    const names = ["main", "feature/foo", "feature/sub/deep", "my-branch_123"];
    for (const name of names) {
      expect(decodeWorkspaceNameFromDir(encodeWorkspaceNameForDir(name))).toBe(name);
    }
  });
});
