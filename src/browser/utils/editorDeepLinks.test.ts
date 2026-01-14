import { describe, expect, test } from "bun:test";
import { getEditorDeepLink, isLocalhost } from "./editorDeepLinks";

describe("getEditorDeepLink", () => {
  describe("local paths", () => {
    test("generates vscode:// URL for local path", () => {
      const url = getEditorDeepLink({
        editor: "vscode",
        path: "/home/user/project/file.ts",
      });
      expect(url).toBe("vscode://file/home/user/project/file.ts");
    });

    test("generates cursor:// URL for local path", () => {
      const url = getEditorDeepLink({
        editor: "cursor",
        path: "/home/user/project/file.ts",
      });
      expect(url).toBe("cursor://file/home/user/project/file.ts");
    });

    test("generates zed:// URL for local path", () => {
      const url = getEditorDeepLink({
        editor: "zed",
        path: "/home/user/project/file.ts",
      });
      expect(url).toBe("zed://file/home/user/project/file.ts");
    });

    test("includes line number in local path", () => {
      const url = getEditorDeepLink({
        editor: "vscode",
        path: "/home/user/project/file.ts",
        line: 42,
      });
      expect(url).toBe("vscode://file/home/user/project/file.ts:42");
    });

    test("includes line and column in local path", () => {
      const url = getEditorDeepLink({
        editor: "cursor",
        path: "/home/user/project/file.ts",
        line: 42,
        column: 10,
      });
      expect(url).toBe("cursor://file/home/user/project/file.ts:42:10");
    });
  });

  describe("SSH remote paths", () => {
    test("generates vscode-remote URL for SSH host", () => {
      const url = getEditorDeepLink({
        editor: "vscode",
        path: "/home/user/project/file.ts",
        sshHost: "devbox",
      });
      expect(url).toBe("vscode://vscode-remote/ssh-remote+devbox/home/user/project/file.ts");
    });

    test("generates cursor-remote URL for SSH host", () => {
      const url = getEditorDeepLink({
        editor: "cursor",
        path: "/home/user/project/file.ts",
        sshHost: "devbox",
      });
      expect(url).toBe("cursor://vscode-remote/ssh-remote+devbox/home/user/project/file.ts");
    });

    test("generates zed://ssh URL for SSH host", () => {
      const url = getEditorDeepLink({
        editor: "zed",
        path: "/home/user/project/file.ts",
        sshHost: "devbox",
      });
      expect(url).toBe("zed://ssh/devbox/home/user/project/file.ts");
    });

    test("includes port in zed://ssh URL when provided in sshHost", () => {
      const url = getEditorDeepLink({
        editor: "zed",
        path: "/home/user/project/file.ts",
        sshHost: "devbox:2222",
      });
      expect(url).toBe("zed://ssh/devbox:2222/home/user/project/file.ts");
    });

    test("encodes SSH host with special characters", () => {
      const url = getEditorDeepLink({
        editor: "vscode",
        path: "/home/user/project/file.ts",
        sshHost: "user@host.example.com",
      });
      expect(url).toBe(
        "vscode://vscode-remote/ssh-remote+user%40host.example.com/home/user/project/file.ts"
      );
    });

    test("includes line number in SSH remote path", () => {
      const url = getEditorDeepLink({
        editor: "vscode",
        path: "/home/user/project/file.ts",
        sshHost: "devbox",
        line: 42,
      });
      expect(url).toBe("vscode://vscode-remote/ssh-remote+devbox/home/user/project/file.ts:42");
    });

    test("includes line and column in SSH remote path", () => {
      const url = getEditorDeepLink({
        editor: "cursor",
        path: "/home/user/project/file.ts",
        sshHost: "devbox",
        line: 42,
        column: 10,
      });
      expect(url).toBe("cursor://vscode-remote/ssh-remote+devbox/home/user/project/file.ts:42:10");
    });
  });
});

describe("isLocalhost", () => {
  test("returns true for localhost", () => {
    expect(isLocalhost("localhost")).toBe(true);
  });

  test("returns true for 127.0.0.1", () => {
    expect(isLocalhost("127.0.0.1")).toBe(true);
  });

  test("returns true for ::1", () => {
    expect(isLocalhost("::1")).toBe(true);
  });

  test("returns false for other hostnames", () => {
    expect(isLocalhost("devbox")).toBe(false);
    expect(isLocalhost("192.168.1.1")).toBe(false);
    expect(isLocalhost("example.com")).toBe(false);
  });
});
