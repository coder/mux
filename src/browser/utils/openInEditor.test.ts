import { describe, expect, test } from "bun:test";
import { openInEditor } from "./openInEditor";
import { getDockerDeepLink } from "./editorDeepLinks";
import type { RuntimeConfig } from "@/common/types/runtime";

interface GlobalWithOptionalWindow {
  window?: unknown;
}

function getGlobalWindow(): unknown {
  return (globalThis as unknown as GlobalWithOptionalWindow).window;
}

function setGlobalWindow(value: unknown): void {
  (globalThis as unknown as GlobalWithOptionalWindow).window = value;
}

function deleteGlobalWindow(): void {
  delete (globalThis as unknown as GlobalWithOptionalWindow).window;
}

function withWindow<T>(windowValue: unknown, fn: () => T): T {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const prevWindow = getGlobalWindow();

  try {
    setGlobalWindow(windowValue);
    return fn();
  } finally {
    if (!hadWindow) {
      deleteGlobalWindow();
    } else {
      setGlobalWindow(prevWindow);
    }
  }
}

describe("openInEditor", () => {
  test("opens SSH file deep link (does not fall back to parent dir)", async () => {
    const calls: Array<{ url: string; target?: string }> = [];

    const runtimeConfig: RuntimeConfig = {
      type: "ssh",
      host: "devbox",
      srcBaseDir: "~/mux",
    };

    const result = await withWindow(
      {
        open: (url: string, target?: string) => {
          calls.push({ url, target });
          return null;
        },
      },
      async () =>
        openInEditor({
          api: null,
          workspaceId: "ws-123",
          targetPath: "/home/user/project/plan.md",
          runtimeConfig,
          isFile: true,
        })
    );

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      {
        url: "vscode://vscode-remote/ssh-remote+devbox/home/user/project/plan.md",
        target: "_blank",
      },
    ]);
  });

  test("opens Docker deep links at parent dir when targetPath is a file", async () => {
    const calls: Array<{ url: string; target?: string }> = [];

    const runtimeConfig: RuntimeConfig = {
      type: "docker",
      image: "node:20",
      containerName: "mux-workspace-123",
    };

    const expectedDeepLink = getDockerDeepLink({
      editor: "vscode",
      containerName: "mux-workspace-123",
      path: "/home/user/project",
    });

    if (!expectedDeepLink) {
      throw new Error("Expected Docker deep link to be generated");
    }

    const result = await withWindow(
      {
        open: (url: string, target?: string) => {
          calls.push({ url, target });
          return null;
        },
      },
      async () =>
        openInEditor({
          api: null,
          workspaceId: "ws-123",
          targetPath: "/home/user/project/plan.md",
          runtimeConfig,
          isFile: true,
        })
    );

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      {
        url: expectedDeepLink,
        target: "_blank",
      },
    ]);
  });
});
