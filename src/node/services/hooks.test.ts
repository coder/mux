import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getHookPath, runWithHook } from "./hooks";

describe("hooks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-hooks-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("getHookPath", () => {
    test("returns null when no hook exists", async () => {
      const result = await getHookPath(tempDir);
      expect(result).toBeNull();
    });

    test("finds project-level hook", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, "#!/bin/bash\necho test");
      await fs.chmod(hookPath, 0o755);

      const result = await getHookPath(tempDir);
      expect(result).toBe(hookPath);
    });

    test("ignores non-executable hook", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });
      await fs.writeFile(hookPath, "#!/bin/bash\necho test");
      // Don't set executable permission

      const result = await getHookPath(tempDir);
      expect(result).toBeNull();
    });

    test("ignores directory with hook name", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookPath, { recursive: true }); // Create as directory

      const result = await getHookPath(tempDir);
      expect(result).toBeNull();
    });
  });

  describe("runWithHook", () => {
    test("executes tool when hook prints __MUX_EXEC__", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that signals ready and reads result
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo __MUX_EXEC__
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      let toolExecuted = false;
      const { result, hook } = await runWithHook(
        hookPath,
        {
          tool: "test_tool",
          toolInput: '{"arg": "value"}',
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        () => {
          toolExecuted = true;
          return Promise.resolve({ success: true, data: "test result" });
        }
      );

      expect(toolExecuted).toBe(true);
      expect(hook.toolExecuted).toBe(true);
      expect(hook.success).toBe(true);
      expect(result).toEqual({ success: true, data: "test result" });
    });

    test("blocks tool when hook exits before __MUX_EXEC__", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that exits immediately with error
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo "Tool blocked by policy" >&2
exit 1
`
      );
      await fs.chmod(hookPath, 0o755);

      let toolExecuted = false;
      const { result, hook } = await runWithHook(
        hookPath,
        {
          tool: "dangerous_tool",
          toolInput: "{}",
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        () => {
          toolExecuted = true;
          return Promise.resolve({ success: true });
        }
      );

      expect(toolExecuted).toBe(false);
      expect(hook.toolExecuted).toBe(false);
      expect(hook.success).toBe(false);
      expect(hook.stderr).toContain("Tool blocked by policy");
      expect(result).toBeUndefined();
    });

    test("captures stderr when hook fails after tool execution", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that runs tool then fails (simulating lint failure)
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo __MUX_EXEC__
read RESULT
echo "Lint error: missing semicolon" >&2
exit 1
`
      );
      await fs.chmod(hookPath, 0o755);

      const { result, hook } = await runWithHook(
        hookPath,
        {
          tool: "file_edit_replace_string",
          toolInput: '{"file_path": "test.ts"}',
          workspaceId: "test-workspace",
          projectDir: tempDir,
        },
        () => {
          return Promise.resolve({ success: true, diff: "+line" });
        }
      );

      expect(hook.toolExecuted).toBe(true);
      expect(hook.success).toBe(false);
      expect(hook.stderr).toContain("Lint error: missing semicolon");
      expect(result).toEqual({ success: true, diff: "+line" });
    });

    test("receives tool input via MUX_TOOL_INPUT env var", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that echoes env vars to stderr for verification
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo "TOOL=$MUX_TOOL" >&2
echo "INPUT=$MUX_TOOL_INPUT" >&2
echo __MUX_EXEC__
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      const { hook } = await runWithHook(
        hookPath,
        {
          tool: "bash",
          toolInput: '{"script": "echo hello"}',
          workspaceId: "ws-123",
          projectDir: tempDir,
        },
        () => Promise.resolve({ success: true })
      );

      expect(hook.stderr).toContain("TOOL=bash");
      expect(hook.stderr).toContain('INPUT={"script": "echo hello"}');
    });

    test("receives tool result via stdin", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      // Hook that reads result and echoes it to stderr
      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo __MUX_EXEC__
read RESULT
echo "GOT_RESULT=$RESULT" >&2
`
      );
      await fs.chmod(hookPath, 0o755);

      const { hook } = await runWithHook(
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
        },
        () => Promise.resolve({ status: "ok", count: 42 })
      );

      expect(hook.stderr).toContain('GOT_RESULT={"status":"ok","count":42}');
    });

    test("passes additional env vars to hook", async () => {
      const hookDir = path.join(tempDir, ".mux");
      const hookPath = path.join(hookDir, "tool_hook");
      await fs.mkdir(hookDir, { recursive: true });

      await fs.writeFile(
        hookPath,
        `#!/bin/bash
echo "SECRET=$MY_SECRET" >&2
echo __MUX_EXEC__
read RESULT
`
      );
      await fs.chmod(hookPath, 0o755);

      const { hook } = await runWithHook(
        hookPath,
        {
          tool: "test",
          toolInput: "{}",
          workspaceId: "test",
          projectDir: tempDir,
          env: { MY_SECRET: "secret-value" },
        },
        () => Promise.resolve({ success: true })
      );

      expect(hook.stderr).toContain("SECRET=secret-value");
    });
  });
});
