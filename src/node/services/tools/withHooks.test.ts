import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { tool } from "ai";
import { z } from "zod";
import { withHooks } from "./withHooks";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

describe("withHooks", () => {
  let tempDir: string;
  let runtime: LocalRuntime;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-withHooks-test-"));
    runtime = new LocalRuntime(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createTestTool(executeFn: (args: { input: string }) => Promise<{ output: string }>) {
    return tool({
      description: "Test tool",
      inputSchema: z.object({ input: z.string() }),
      execute: (args) => executeFn(args),
    });
  }

  test("executes tool directly when no hook exists", async () => {
    const baseTool = createTestTool((args) =>
      Promise.resolve({ output: `processed: ${args.input}` })
    );

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = await wrappedTool.execute!({ input: "hello" }, {} as never);
    expect(result).toEqual({ output: "processed: hello" });
  });

  test("executes tool through hook when hook exists", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo __MUX_EXEC__
read RESULT
`
    );
    await fs.chmod(hookPath, 0o755);

    const baseTool = createTestTool((args) =>
      Promise.resolve({ output: `processed: ${args.input}` })
    );

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = await wrappedTool.execute!({ input: "world" }, {} as never);
    expect(result).toEqual({ output: "processed: world" });
  });

  test("returns error when hook blocks execution", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo "Blocked: dangerous operation" >&2
exit 1
`
    );
    await fs.chmod(hookPath, 0o755);

    let toolCalled = false;
    const baseTool = createTestTool(() => {
      toolCalled = true;
      return Promise.resolve({ output: "should not run" });
    });

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as {
      error?: string;
    };
    expect(toolCalled).toBe(false);
    expect(result.error).toContain("Blocked: dangerous operation");
  });

  test("appends hook_output when hook fails after execution", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo __MUX_EXEC__
read RESULT
echo "Lint failed: syntax error" >&2
exit 1
`
    );
    await fs.chmod(hookPath, 0o755);

    const baseTool = createTestTool(() => Promise.resolve({ output: "edit complete" }));

    const wrappedTool = withHooks("file_edit", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as {
      output: string;
      hook_output?: string;
    };
    expect(result.output).toBe("edit complete");
    expect(result.hook_output).toContain("Lint failed: syntax error");
  });

  test("appends hook_output when hook succeeds with output", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo __MUX_EXEC__
read RESULT
echo "Formatted: test.ts" >&2
exit 0
`
    );
    await fs.chmod(hookPath, 0o755);

    const baseTool = createTestTool(() => Promise.resolve({ output: "edit complete" }));

    const wrappedTool = withHooks("file_edit", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as {
      output: string;
      hook_output?: string;
    };
    expect(result.output).toBe("edit complete");
    expect(result.hook_output).toContain("Formatted: test.ts");
  });

  test("passes env to hook", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
# Exit with error if SECRET is not set correctly
if [ "$MY_API_KEY" != "secret123" ]; then
  echo "SECRET not found" >&2
  exit 1
fi
echo __MUX_EXEC__
read RESULT
`
    );
    await fs.chmod(hookPath, 0o755);

    const baseTool = createTestTool(() => Promise.resolve({ output: "ok" }));

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
      env: { MY_API_KEY: "secret123" },
    });

    const result = await wrappedTool.execute!({ input: "test" }, {} as never);
    expect(result).toEqual({ output: "ok" });
  });
});
