import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowActionRunner } from "./WorkflowActionRunner";
import { hashWorkflowActionSource, type ResolvedWorkflowAction } from "./WorkflowActionRegistry";

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
