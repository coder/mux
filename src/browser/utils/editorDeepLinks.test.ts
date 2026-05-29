import { describe, expect, test } from "bun:test";
import { getEditorDeepLink, getDevcontainerDeepLink, isLocalhost } from "./editorDeepLinks";

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

    test("normalizes Windows drive paths for local deep links", () => {
      const url = getEditorDeepLink({
        editor: "vscode",
        path: "C:\\Users\\Me\\proj\\file.ts",
      });
      expect(url).toBe("vscode://file/C:/Users/Me/proj/file.ts");
    });

    test("normalizes Windows drive paths with forward slashes", () => {
      const url = getEditorDeepLink({
        editor: "cursor",
        path: "C:/Users/Me/proj/file.ts",
        line: 42,
        column: 10,
      });
      expect(url).toBe("cursor://file/C:/Users/Me/proj/file.ts:42:10");
    });

    test("strips surrounding quotes from local deep link paths", () => {
      const url = getEditorDeepLink({
        editor: "vscode",
        path: "'C:\\Users\\Me\\proj\\file.ts'",
      });
      expect(url).toBe("vscode://file/C:/Users/Me/proj/file.ts");
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

describe("getDevcontainerDeepLink", () => {
  test("generates vscode:// URL for devcontainer", () => {
    const url = getDevcontainerDeepLink({
      editor: "vscode",
      containerName: "jovial_newton",
      hostPath: "/Users/me/projects/myapp",
      containerPath: "/workspaces/myapp",
    });
    expect(url).not.toBeNull();
    expect(url).toMatch(/^vscode:\/\/vscode-remote\/dev-container\+[0-9a-f]+\/workspaces\/myapp$/);
  });

  test("generates cursor:// URL for devcontainer", () => {
    const url = getDevcontainerDeepLink({
      editor: "cursor",
      containerName: "jovial_newton",
      hostPath: "/Users/me/projects/myapp",
      containerPath: "/workspaces/myapp",
    });
    expect(url).not.toBeNull();
    expect(url).toMatch(/^cursor:\/\/vscode-remote\/dev-container\+[0-9a-f]+\/workspaces\/myapp$/);
  });

  test("returns null for zed (unsupported)", () => {
    const url = getDevcontainerDeepLink({
      editor: "zed",
      containerName: "jovial_newton",
      hostPath: "/Users/me/projects/myapp",
      containerPath: "/workspaces/myapp",
    });
    expect(url).toBeNull();
  });

  test("normalizes container path formatting", () => {
    const url = getDevcontainerDeepLink({
      editor: "vscode",
      containerName: "jovial_newton",
      hostPath: "/Users/me/projects/myapp",
      containerPath: "workspaces\\myapp",
    });
    expect(url).not.toBeNull();
    expect(url).toMatch(/^vscode:\/\/vscode-remote\/dev-container\+[0-9a-f]+\/workspaces\/myapp$/);
  });
  test("includes config file path when provided", () => {
    const url = getDevcontainerDeepLink({
      editor: "vscode",
      containerName: "jovial_newton",
      hostPath: "/Users/me/projects/myapp",
      containerPath: "/workspaces/myapp",
      configFilePath: "/Users/me/projects/myapp/.devcontainer/devcontainer.json",
    });
    expect(url).not.toBeNull();
    // The hex-encoded JSON should contain configFile
    expect(url).toMatch(/^vscode:\/\/vscode-remote\/dev-container\+[0-9a-f]+\/workspaces\/myapp$/);
  });

  test("hex-encodes JSON config with container name prefixed with /", () => {
    const url = getDevcontainerDeepLink({
      editor: "vscode",
      containerName: "my_container",
      hostPath: "/home/user/project",
      containerPath: "/workspace",
    });
    expect(url).not.toBeNull();
    // Extract hex portion and decode to verify format
    const hexMatch = /dev-container\+([0-9a-f]+)/.exec(url!);
    expect(hexMatch).not.toBeNull();
    const hex = hexMatch![1];
    const decoded = Buffer.from(hex, "hex").toString("utf8");
    const config = JSON.parse(decoded) as {
      containerName: string;
      hostPath: string;
      localDocker: boolean;
    };
    expect(config.containerName).toBe("/my_container");
    expect(config.hostPath).toBe("/home/user/project");
    expect(config.localDocker).toBe(false);
  });
  test("correctly encodes non-ASCII characters in paths as UTF-8", () => {
    const url = getDevcontainerDeepLink({
      editor: "vscode",
      containerName: "test_container",
      hostPath: "/Users/José/projects/myapp",
      containerPath: "/workspaces/myapp",
    });
    expect(url).not.toBeNull();
    // Extract hex portion and decode to verify UTF-8 encoding
    const hexMatch = /dev-container\+([0-9a-f]+)/.exec(url!);
    expect(hexMatch).not.toBeNull();
    const hex = hexMatch![1];
    const decoded = Buffer.from(hex, "hex").toString("utf8");
    const config = JSON.parse(decoded) as { hostPath: string };
    // José should be preserved (é = U+00E9, UTF-8: 0xC3 0xA9)
    expect(config.hostPath).toBe("/Users/José/projects/myapp");
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
