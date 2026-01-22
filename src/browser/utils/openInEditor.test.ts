import { describe, expect, test } from "bun:test";
import { openInEditor } from "./openInEditor";
import type { RuntimeConfig } from "@/common/types/runtime";

interface GlobalWithOptionalWindow {
  window?: unknown;
}

function withWindow<T>(windowValue: unknown, fn: () => T): T {
  const globalWithWindow = globalThis as unknown as GlobalWithOptionalWindow;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalWithWindow, "window");
  const prevWindow = globalWithWindow.window;

  try {
    globalWithWindow.window = windowValue;
    return fn();
  } finally {
    if (!hadWindow) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = prevWindow;
    }
  }
}

describe("openInEditor", () => {
  const workspaceId = "ws-123";
  const filePath = "/home/user/project/plan.md";
  const parentDir = "/home/user/project";

  type OpenCall = [url: string, target?: string];

  function createMockWindow(calls: OpenCall[]) {
    return {
      localStorage: { getItem: () => null },
      open: (url: string, target?: string) => {
        calls.push([url, target]);
        return null;
      },
    };
  }

  test("opens SSH file deep link (does not fall back to parent dir)", async () => {
    const calls: OpenCall[] = [];

    const runtimeConfig: RuntimeConfig = {
      type: "ssh",
      host: "devbox",
      srcBaseDir: "~/mux",
    };

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api: null,
        workspaceId,
        targetPath: filePath,
        runtimeConfig,
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);

    const [url, target] = calls[0];
    expect(target).toBe("_blank");
    expect(url.includes("ssh-remote+devbox")).toBe(true);
    expect(url.endsWith(`${filePath}:1:1`)).toBe(true);
  });

  test("opens Docker deep links at parent dir when targetPath is a file", async () => {
    const calls: OpenCall[] = [];

    const runtimeConfig: RuntimeConfig = {
      type: "docker",
      image: "node:20",
      containerName: "mux-workspace-123",
    };

    const result = await withWindow(createMockWindow(calls), () =>
      openInEditor({
        api: null,
        workspaceId,
        targetPath: filePath,
        runtimeConfig,
        isFile: true,
      })
    );

    expect(result.success).toBe(true);
    expect(calls.length).toBe(1);

    const [url, target] = calls[0];
    expect(target).toBe("_blank");
    expect(url.endsWith(filePath)).toBe(false);
    expect(url.endsWith(`/${parentDir}`)).toBe(true);
  });
});
