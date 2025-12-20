import * as os from "os";
import * as path from "path";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { z } from "zod";
import { tool } from "ai";
import { ExtensionManager } from "./extensionManager";

describe("ExtensionManager", () => {
  it("wrapToolsWithPostToolUse lets extensions transform tool results", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-ext-mgr-"));
    try {
      const extDir = path.join(tempRoot, "ext");
      await mkdir(extDir, { recursive: true });

      await writeFile(
        path.join(extDir, "transform.js"),
        [
          "module.exports = {",
          "  onPostToolUse: (payload) => ({ result: { seen: payload.toolCallId, original: payload.result } }),",
          "};",
          "",
        ].join("\n"),
        "utf-8"
      );

      const manager = new ExtensionManager({ extDir, hookTimeoutMs: 1000 });

      const base = tool({
        description: "test",
        inputSchema: z.object({ x: z.number() }),
        execute: async ({ x }: { x: number }) => ({ x }),
      });

      const wrapped = manager.wrapToolsWithPostToolUse(
        { test: base },
        {
          workspaceId: "w1",
          projectPath: "/tmp/project",
          workspacePath: "/tmp/project",
          runtimeConfig: { type: "local" },
          runtimeTempDir: "/tmp",
          // Runtime isn't used by this test extension; provide a minimal stub.
          runtime: {
            exec: async () => {
              throw new Error("not used");
            },
          } as never,
        }
      );

      const testTool = wrapped.test;
      if (!testTool?.execute) {
        throw new Error("wrapped tool missing execute");
      }

      const result = await (testTool.execute as (args: unknown, options: unknown) => Promise<unknown>)(
        { x: 1 },
        { toolCallId: "call-123" }
      );

      expect(result).toEqual({ seen: "call-123", original: { x: 1 } });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns original tool result when hook times out", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mux-ext-mgr-timeout-"));
    try {
      const extDir = path.join(tempRoot, "ext");
      await mkdir(extDir, { recursive: true });

      await writeFile(
        path.join(extDir, "hang.js"),
        [
          "module.exports = {",
          "  onPostToolUse: async () => new Promise(() => {}),",
          "};",
          "",
        ].join("\n"),
        "utf-8"
      );

      const manager = new ExtensionManager({ extDir, hookTimeoutMs: 10 });

      const base = tool({
        description: "test",
        inputSchema: z.object({}),
        execute: async () => "ok",
      });

      const wrapped = manager.wrapToolsWithPostToolUse(
        { test: base },
        {
          workspaceId: "w1",
          projectPath: "/tmp/project",
          workspacePath: "/tmp/project",
          runtimeConfig: { type: "local" },
          runtimeTempDir: "/tmp",
          runtime: {} as never,
        }
      );

      const result = await (wrapped.test!.execute as (args: unknown, options: unknown) => Promise<unknown>)(
        {},
        { toolCallId: "call" }
      );

      expect(result).toBe("ok");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
