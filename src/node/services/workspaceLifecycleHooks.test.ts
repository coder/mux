import { describe, expect, it } from "bun:test";
import { WorkspaceLifecycleHooks } from "./workspaceLifecycleHooks";
import { Err, Ok } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";

const TEST_METADATA: WorkspaceMetadata = {
  id: "ws",
  name: "ws",
  projectName: "proj",
  projectPath: "/tmp/proj",
  runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
};

describe("WorkspaceLifecycleHooks", () => {
  it("runs beforeArchive hooks sequentially in registration order", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const calls: string[] = [];
    hooks.registerBeforeArchive(async () => {
      calls.push("first");
      return Ok(undefined);
    });
    hooks.registerBeforeArchive(async () => {
      calls.push("second");
      return Ok(undefined);
    });

    const result = await hooks.runBeforeArchive({
      workspaceId: "ws",
      workspaceMetadata: TEST_METADATA,
    });

    expect(result.success).toBe(true);
    expect(calls).toEqual(["first", "second"]);
  });

  it("stops running hooks after the first Err result", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const calls: string[] = [];
    hooks.registerBeforeArchive(async () => {
      calls.push("first");
      return Ok(undefined);
    });
    hooks.registerBeforeArchive(async () => {
      calls.push("second");
      return Err("nope\nextra");
    });
    hooks.registerBeforeArchive(async () => {
      calls.push("third");
      return Ok(undefined);
    });

    const result = await hooks.runBeforeArchive({
      workspaceId: "ws",
      workspaceMetadata: TEST_METADATA,
    });

    expect(calls).toEqual(["first", "second"]);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Hook errors are sanitized to a single line.
      expect(result.error).toBe("nope");
    }
  });

  it("returns Err when a hook throws (and sanitizes the thrown message)", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    hooks.registerBeforeArchive(async () => {
      throw new Error("boom\nstack");
    });

    const result = await hooks.runBeforeArchive({
      workspaceId: "ws",
      workspaceMetadata: TEST_METADATA,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("beforeArchive hook threw: boom");
    }
  });
});
