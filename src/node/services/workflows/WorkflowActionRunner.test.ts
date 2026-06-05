import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowActionRunner } from "./WorkflowActionRunner";
import {
  hashWorkflowActionSource,
  WorkflowActionRegistry,
  type ResolvedWorkflowAction,
} from "./WorkflowActionRegistry";

const execFileAsync = promisify(execFile);

function createAction(sourcePath: string, source: string): ResolvedWorkflowAction {
  return {
    name: "demo.read",
    scope: "project",
    sourcePath,
    source,
    sourceHash: hashWorkflowActionSource(source),
  };
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toMatch(pattern);
    return;
  }
  throw new Error("Expected promise to reject");
}

async function expectTimeout(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toMatch(/timed out/);
    return;
  }
  throw new Error("Expected action to time out");
}

describe("WorkflowActionRunner", () => {
  test("runs JavaScript actions out of process and captures diagnostics/artifacts", async () => {
    using tmp = new DisposableTempDir("workflow-action-runner");
    const sourcePath = path.join(tmp.path, "action.js");
    const source = `
      export const metadata = {
        version: 1,
        description: "Echo input",
        effect: "read",
        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        outputSchema: { type: "object", required: ["greeting"], properties: { greeting: { type: "string" } } },
      };
      export async function execute(input, ctx) {
        console.log("running " + input.name);
        await ctx.writeArtifact("greeting.json", { name: input.name });
        return { greeting: "hello " + input.name };
      }
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();
    const action = createAction(sourcePath, source);

    const description = await runner.describe(action);
    expect(description.metadata.description).toBe("Echo input");
    expect(description.metadata.effect).toBe("read");
    expect(description.hasReconcile).toBe(false);
    const result = await runner.execute(action, {
      input: { name: "Ada" },
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    expect(result.output).toEqual({ greeting: "hello Ada" });
    expect(result.stdout).toContain("running Ada");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.name).toBe("greeting.json");
    expect(result.artifacts[0]?.sizeBytes).toBeGreaterThan(0);
    const artifactContent = await fs.readFile(
      path.join(tmp.path, "artifacts", "greeting.json"),
      "utf-8"
    );
    expect(artifactContent).toContain("Ada");
  });

  test("uses the configured cwd for the action process", async () => {
    using tmp = new DisposableTempDir("workflow-action-cwd");
    const cwd = path.join(tmp.path, "cwd");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "relative.txt"), "from cwd", "utf-8");
    const sourcePath = path.join(tmp.path, "cwd.js");
    const source = `
      const fs = require("node:fs");
      module.exports.metadata = { version: 1, description: "Cwd", effect: "read" };
      module.exports.execute = async () => ({
        cwd: process.cwd(),
        relative: fs.readFileSync("relative.txt", "utf-8"),
      });
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    expect(result.output).toEqual({ cwd, relative: "from cwd" });
  });

  test("rejects stale result files from previous attempts", async () => {
    using tmp = new DisposableTempDir("workflow-action-stale-result");
    const sourcePath = path.join(tmp.path, "exit.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Exit", effect: "read" };
      module.exports.execute = async () => process.exit(2);
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const artifactDir = path.join(tmp.path, "artifacts");
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, ".mux-action-result.json"),
      JSON.stringify({
        attemptId: "old-attempt",
        success: true,
        metadata: { version: 1, description: "Old", effect: "read" },
        output: { stale: true },
        artifacts: [],
      }),
      "utf-8"
    );
    const runner = new WorkflowActionRunner();

    await expectRejects(
      runner.execute(createAction(sourcePath, source), {
        input: null,
        cwd: tmp.path,
        timeoutMs: 10_000,
        artifactDir,
      }),
      /valid result|stale result|exited/
    );
  });

  test("truncates noisy action diagnostics before returning", async () => {
    using tmp = new DisposableTempDir("workflow-action-output-limit");
    const sourcePath = path.join(tmp.path, "noisy.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Noisy", effect: "read" };
      module.exports.execute = async () => {
        console.log("x".repeat(70 * 1024));
        return { ok: true };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    expect(result.stdout.length).toBeLessThan(70 * 1024);
    expect(result.stdout).toContain("truncated after");
  });

  test("exposes ctx.exec truncation as structured output", async () => {
    using tmp = new DisposableTempDir("workflow-action-exec-output-limit");
    const sourcePath = path.join(tmp.path, "exec-noisy.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Exec noisy", effect: "read" };
      module.exports.execute = async (_input, ctx) => {
        return await ctx.exec(process.execPath, ["-e", "process.stdout.write('x'.repeat(70 * 1024))"]);
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    expect(result.output).toMatchObject({
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: false,
    });
  });

  test("keeps ctx.exec output out of action diagnostics", async () => {
    using tmp = new DisposableTempDir("workflow-action-exec-diagnostics");
    const sourcePath = path.join(tmp.path, "exec-diagnostics.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Exec diagnostics", effect: "read" };
      module.exports.execute = async (_input, ctx) => {
        console.log("action log");
        const result = await ctx.exec(process.execPath, ["-e", "process.stdout.write('cmd stdout'); process.stderr.write('cmd stderr')"]);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    expect(result.output).toEqual({ stdout: "cmd stdout", stderr: "cmd stderr", exitCode: 0 });
    expect(result.stdout).toBe("action log\n");
    expect(result.stderr).toBe("");
  });

  test("keeps cleanup ps warnings out of action diagnostics", async () => {
    if (process.platform === "win32") {
      return;
    }
    using tmp = new DisposableTempDir("workflow-action-ps-diagnostics");
    const fakeBinDir = path.join(tmp.path, "bin");
    const fakePsPath = path.join(fakeBinDir, "ps");
    const sourcePath = path.join(tmp.path, "ps-diagnostics.js");
    const sentinel = "fake ps warning should stay hidden";
    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.writeFile(fakePsPath, `#!/bin/sh\nprintf '${sentinel}\\n' >&2\n`, "utf-8");
    await fs.chmod(fakePsPath, 0o755);
    const source = `
      module.exports.metadata = { version: 1, description: "Ps diagnostics", effect: "read" };
      module.exports.execute = async (_input, ctx) => {
        process.env.PATH = ${JSON.stringify(fakeBinDir + path.delimiter)} + (process.env.PATH || "");
        const result = await ctx.exec(process.execPath, ["-e", ""]);
        return { exitCode: result.exitCode };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    expect(result.output).toEqual({ exitCode: 0 });
    expect(result.stderr).not.toContain(sentinel);
    expect(result.stderr).toBe("");
  });

  test("built-in git actions reject truncated command output", async () => {
    using tmp = new DisposableTempDir("workflow-action-git-truncated");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repoRoot });
    for (let index = 0; index < 1800; index += 1) {
      await fs.writeFile(
        path.join(repoRoot, `untracked-${String(index).padStart(4, "0")}-${"x".repeat(40)}.txt`),
        "x",
        "utf-8"
      );
    }
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const action = await registry.resolveAction("git.changedFiles", { projectTrusted: false });
    const runner = new WorkflowActionRunner();

    await expectRejects(
      runner.execute(action, {
        input: null,
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts"),
      }),
      /capture limit/
    );
  });

  test("reports unsupported module syntax clearly", async () => {
    using tmp = new DisposableTempDir("workflow-action-import");
    const sourcePath = path.join(tmp.path, "import.js");
    const source = `import path from "node:path";
      export const metadata = { version: 1, description: path.sep, effect: "read" };
      export async function execute() { return null; }
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    await expectRejects(
      runner.describe(createAction(sourcePath, source)),
      /static import\/export lists are not supported/
    );
  });

  test("does not evaluate action top-level code while describing metadata", async () => {
    using tmp = new DisposableTempDir("workflow-action-static-describe");
    const markerPath = path.join(tmp.path, "loaded.txt");
    const sourcePath = path.join(tmp.path, "static.js");
    const source = `
      require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "loaded");
      export const metadata = { version: 1, description: "Static", effect: "read" };
      export async function execute() { return { ok: true }; }
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const description = await runner.describe(createAction(sourcePath, source));

    expect(description.metadata.description).toBe("Static");
    await expectRejects(fs.access(markerPath), /no such file|ENOENT/i);
  });

  test("ignores metadata and reconcile text inside comments and strings", async () => {
    using tmp = new DisposableTempDir("workflow-action-static-comment-mask");
    const sourcePath = path.join(tmp.path, "commented.js");
    const source = `
      /* module.exports.metadata = { version: 1, description: "Fake", effect: "external" }; */
      const ignored = "module.exports.reconcile = async () => null";
      module.exports.metadata = { version: 1, description: "Real", effect: "read" };
      module.exports.execute = async () => ({ ok: true });
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const description = await runner.describe(createAction(sourcePath, source));

    expect(description.metadata.description).toBe("Real");
    expect(description.metadata.effect).toBe("read");
    expect(description.hasReconcile).toBe(false);
  });

  test("does not rewrite export syntax inside action strings", async () => {
    using tmp = new DisposableTempDir("workflow-action-export-template");
    const sourcePath = path.join(tmp.path, "template.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Template", effect: "read" };
      const generated = \`
export const value = 1;
export default value;
\`;
      module.exports.execute = async () => generated;
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    if (typeof result.output !== "string") {
      throw new Error("Expected string output");
    }
    expect(result.output).toContain("export const value = 1;");
    expect(result.output).toContain("export default value;");
  });

  test("requires executable action exports during describe", async () => {
    using tmp = new DisposableTempDir("workflow-action-missing-execute");
    const sourcePath = path.join(tmp.path, "missing-execute.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Metadata only", effect: "read" };
      module.exports.reconcile = 42;
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    await expectRejects(runner.describe(createAction(sourcePath, source)), /execute function/);
  });

  test("rejects artifacts that collide with the action result control file", async () => {
    using tmp = new DisposableTempDir("workflow-action-result-artifact-collision");
    const sourcePath = path.join(tmp.path, "collision.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Collision", effect: "read" };
      module.exports.execute = async (_input, ctx) => {
        await ctx.writeArtifact(".mux-action-result.json", "collision");
        return { ok: true };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    await expectRejects(
      runner.execute(createAction(sourcePath, source), {
        input: null,
        cwd: tmp.path,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts"),
      }),
      /reserved for workflow action internals/
    );
  });

  test("kills ctx.exec descendants when the action timeout fires", async () => {
    using tmp = new DisposableTempDir("workflow-action-exec-timeout");
    const markerPath = path.join(tmp.path, "survived.txt");
    const sourcePath = path.join(tmp.path, "exec-timeout.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Exec timeout", effect: "read" };
      module.exports.execute = async (_input, ctx) => {
        await ctx.exec("sh", ["-c", ${JSON.stringify(`sleep 0.25; echo survived > ${markerPath}`)}]);
        return { ok: true };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    await expectTimeout(
      runner.execute(createAction(sourcePath, source), {
        input: null,
        cwd: tmp.path,
        timeoutMs: 25,
        artifactDir: path.join(tmp.path, "artifacts"),
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    await expectRejects(fs.access(markerPath), /no such file|ENOENT/i);
  });

  test("cleans up ctx.exec descendants left behind by a completed command", async () => {
    using tmp = new DisposableTempDir("workflow-action-exec-background-cleanup");
    const markerPath = path.join(tmp.path, "survived.txt");
    const sourcePath = path.join(tmp.path, "exec-background-cleanup.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Exec background cleanup", effect: "read" };
      module.exports.execute = async (_input, ctx) => {
        const result = await ctx.exec("sh", ["-c", ${JSON.stringify(`(sleep 0.25; echo survived > ${markerPath}) >/dev/null 2>&1 &`)}]);
        return { exitCode: result.exitCode };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(result.output).toEqual({ exitCode: 0 });
    await expectRejects(fs.access(markerPath), /no such file|ENOENT/i);
  });

  test("kills ctx.exec descendants when the command timeout fires", async () => {
    using tmp = new DisposableTempDir("workflow-action-exec-command-timeout");
    const markerPath = path.join(tmp.path, "survived.txt");
    const sourcePath = path.join(tmp.path, "exec-command-timeout.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Exec command timeout", effect: "read" };
      module.exports.execute = async (_input, ctx) => {
        const result = await ctx.exec("sh", ["-c", ${JSON.stringify(`(sleep 0.25; echo survived > ${markerPath}) & wait`)}], { timeoutMs: 25 });
        return { timedOut: result.timedOut };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(result.output).toEqual({ timedOut: true });
    await expectRejects(fs.access(markerPath), /no such file|ENOENT/i);
  });

  test("kills actions that exceed their timeout", async () => {
    using tmp = new DisposableTempDir("workflow-action-timeout");
    const sourcePath = path.join(tmp.path, "slow.js");
    const source = `
      module.exports.metadata = { version: 1, description: "Slow", effect: "read" };
      module.exports.execute = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { ok: true };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    await expectTimeout(
      runner.execute(createAction(sourcePath, source), {
        input: null,
        cwd: tmp.path,
        timeoutMs: 10,
        artifactDir: path.join(tmp.path, "artifacts"),
      })
    );
  });
});
