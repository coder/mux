import { describe, test, expect } from "bun:test";
import * as path from "path";
import * as os from "os";
import { promises as fsPromises } from "fs";

import { runWorkspaceScript } from "@/node/services/scriptRunner";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

interface WorkspaceContext {
  workspacePath: string;
  persistentRoot: string;
  runtime: LocalRuntime;
  cleanup: () => Promise<void>;
}

async function createWorkspaceWithScript(
  scriptName: string,
  scriptContents: string
): Promise<WorkspaceContext> {
  const workspacePath = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-script-runner-"));

  const scriptsDir = path.join(workspacePath, ".mux", "scripts");
  await fsPromises.mkdir(scriptsDir, { recursive: true });

  const scriptPath = path.join(scriptsDir, scriptName);
  await fsPromises.writeFile(scriptPath, scriptContents, { mode: 0o755 });
  await fsPromises.chmod(scriptPath, 0o755);

  const persistentRoot = path.join(workspacePath, ".mux-temp-root");
  await fsPromises.mkdir(persistentRoot, { recursive: true });

  const runtime = new LocalRuntime(path.dirname(workspacePath));

  const cleanup = async () => {
    await fsPromises.rm(workspacePath, { recursive: true, force: true });
  };

  return { workspacePath, persistentRoot, runtime, cleanup };
}

function extractOverflowPath(errorText: string): string | undefined {
  const match = /saved to (.+)/.exec(errorText);
  return match?.[1]?.trim();
}

async function waitForDirEmpty(dir: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const entries = await fsPromises.readdir(dir);
      if (entries.length === 0) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return true;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  try {
    const entries = await fsPromises.readdir(dir);
    return entries.length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

describe("runWorkspaceScript persistent temp directory handling", () => {
  const overflowScript = `#!/usr/bin/env bash
set -euo pipefail
node - <<'NODE'
const chunk = '0123456789'.repeat(200);
for (let i = 0; i < 400; i++) {
  console.log(chunk);
}
NODE
`;

  const simpleScript = `#!/usr/bin/env bash
set -euo pipefail
echo "done"
`;

  test("preserves tmpfile overflow logs when persistent dir is provided", async () => {
    const context = await createWorkspaceWithScript("overflow", overflowScript);
    const { workspacePath, persistentRoot, runtime, cleanup } = context;

    try {
      const result = await runWorkspaceScript(runtime, workspacePath, "overflow", [], {
        overflowPolicy: "tmpfile",
        persistentTempDir: persistentRoot,
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success, got error: ${result.error}`);
      }
      const toolResult = result.data.toolResult;
      expect(toolResult.success).toBe(false);
      if (toolResult.success) {
        throw new Error("Expected bash tool failure for overflow scenario");
      }
      expect(toolResult.error).toContain("OUTPUT OVERFLOW");

      const overflowPath = extractOverflowPath(toolResult.error ?? "");
      expect(overflowPath).toBeTruthy();
      await fsPromises.access(overflowPath!);
    } finally {
      await fsPromises.rm(persistentRoot, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("cleans persistent temp subdirectories when no overflow occurs", async () => {
    const context = await createWorkspaceWithScript("light", simpleScript);
    const { workspacePath, persistentRoot, runtime, cleanup } = context;

    try {
      const result = await runWorkspaceScript(runtime, workspacePath, "light", [], {
        overflowPolicy: "tmpfile",
        persistentTempDir: persistentRoot,
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success, got error: ${result.error}`);
      }
      expect(result.data.toolResult.success).toBe(true);

      const emptied = await waitForDirEmpty(persistentRoot);
      expect(emptied).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
