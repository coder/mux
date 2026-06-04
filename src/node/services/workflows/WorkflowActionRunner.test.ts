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
