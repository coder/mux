import { describe, expect, test } from "bun:test";
import {
  getEditorDeepLinkFallbackUrl,
  shouldAttemptEditorDeepLinkFallback,
} from "./openInEditorDeepLinkFallback";

import type { RuntimeConfig } from "@/common/types/runtime";

describe("shouldAttemptEditorDeepLinkFallback", () => {
  test("returns true for EditorService command-not-found error", () => {
    expect(shouldAttemptEditorDeepLinkFallback("Editor command not found: code")).toBe(true);
  });

  test("returns false for unrelated errors", () => {
    expect(shouldAttemptEditorDeepLinkFallback("Some other error")).toBe(false);
    expect(shouldAttemptEditorDeepLinkFallback(undefined)).toBe(false);
  });
});

describe("getEditorDeepLinkFallbackUrl", () => {
  test("returns vscode://file URL for local path", () => {
    const url = getEditorDeepLinkFallbackUrl({
      editor: "vscode",
      targetPath: "/home/user/project/file.ts",
      error: "Editor command not found: code",
    });
    expect(url).toBe("vscode://file/home/user/project/file.ts");
  });

  test("returns cursor://vscode-remote URL for SSH runtime", () => {
    const runtimeConfig: RuntimeConfig = {
      type: "ssh",
      host: "devbox",
      srcBaseDir: "~/mux",
    };

    const url = getEditorDeepLinkFallbackUrl({
      editor: "cursor",
      targetPath: "/home/user/project/file.ts",
      runtimeConfig,
      error: "Editor command not found: cursor",
    });

    expect(url).toBe("cursor://vscode-remote/ssh-remote+devbox/home/user/project/file.ts");
  });

  test("returns null for zed + SSH runtime (unsupported)", () => {
    const runtimeConfig: RuntimeConfig = {
      type: "ssh",
      host: "devbox",
      srcBaseDir: "~/mux",
    };

    const url = getEditorDeepLinkFallbackUrl({
      editor: "zed",
      targetPath: "/home/user/project/file.ts",
      runtimeConfig,
      error: "Editor command not found: zed",
    });

    expect(url).toBeNull();
  });

  test("returns null when error is not command-not-found", () => {
    const url = getEditorDeepLinkFallbackUrl({
      editor: "vscode",
      targetPath: "/home/user/project/file.ts",
      error: "Permission denied",
    });

    expect(url).toBeNull();
  });
});
