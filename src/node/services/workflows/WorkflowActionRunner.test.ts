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

function expectObjectRecord(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function readGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trimEnd();
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
      const s = mux.schema;
      export const metadata = {
        version: 1,
        description: "Echo input",
        effect: "read",
        inputSchema: s.object(
          { name: s.string(), title: s.optional(s.string()) },
          { additionalProperties: false }
        ),
        outputSchema: s.object(
          { greeting: s.string(), nickname: s.optional(s.nullable(s.string())) },
          { additionalProperties: false }
        ),
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
    expect(description.metadata.inputSchema).toEqual({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, title: { type: "string" } },
      additionalProperties: false,
    });
    expect(description.metadata.outputSchema).toEqual({
      type: "object",
      required: ["greeting"],
      properties: { greeting: { type: "string" }, nickname: { type: ["string", "null"] } },
      additionalProperties: false,
    });
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

  test("rejects schema aliases declared after action metadata", async () => {
    using tmp = new DisposableTempDir("workflow-action-late-alias");
    const runner = new WorkflowActionRunner();
    const sources = [
      `export const metadata = {
  version: 1,
  description: "Late alias",
  effect: "read",
  inputSchema: s.object({ name: s.string() }),
};
const s = mux.schema;
export async function execute() { return {}; }
`,
      `module.exports.metadata = {
  version: 1,
  description: "Late alias",
  effect: "read",
  inputSchema: s.object({ name: s.string() }),
};
const s = mux.schema;
module.exports.execute = async function () { return {}; };
`,
    ];

    for (const [index, source] of sources.entries()) {
      const sourcePath = path.join(tmp.path, `late-${index}.js`);
      await fs.writeFile(sourcePath, source, "utf-8");
      await expectRejects(runner.describe(createAction(sourcePath, source)), /Workflow metadata/);
    }
  });

  test("rejects interpolated template literal metadata", async () => {
    using tmp = new DisposableTempDir("workflow-action-interpolated-metadata");
    const sourcePath = path.join(tmp.path, "interpolated.js");
    const source =
      'const branch = "main";\nexport const metadata = { version: 1, description: `Review ${branch}`, effect: "read" };\nexport async function execute() { return {}; }\n';
    await fs.writeFile(sourcePath, source, "utf-8");

    await expectRejects(
      new WorkflowActionRunner().describe(createAction(sourcePath, source)),
      /Workflow metadata/
    );
  });

  test("executes actions with regex literals before exports", async () => {
    using tmp = new DisposableTempDir("workflow-action-regex-before-export");
    const sourcePath = path.join(tmp.path, "regex.js");
    const source = `
      const objectStart = /\\{/;
      export const metadata = { version: 1, description: "Regex before export", effect: "read" };
      export async function execute() {
        return { ok: objectStart.test("{") };
      }
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();
    const action = createAction(sourcePath, source);

    const description = await runner.describe(action);
    const result = await runner.execute(action, {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    expect(description.hasReconcile).toBe(false);
    expect(result.output).toEqual({ ok: true });
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

  test("provides action SDK helpers for checked exec, JSON exec, and temporary JSON", async () => {
    using tmp = new DisposableTempDir("workflow-action-sdk-helpers");
    const sourcePath = path.join(tmp.path, "sdk.js");
    const source = `
      export const metadata = { version: 1, description: "SDK helpers", effect: "read" };
      export async function execute(_input, ctx) {
        const checked = await ctx.execChecked(process.execPath, ["-e", "process.stdout.write('ok')"]);
        const parsed = await ctx.execJson(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ value: 42 }))"]);
        const temp = await ctx.writeTempJson({ hello: "world" });
        const tempContent = JSON.parse(await require("node:fs/promises").readFile(temp.path, "utf-8"));
        return { checked: checked.stdout, parsed, tempContent, tempPath: temp.path };
      }
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });
    const output = expectObjectRecord(result.output);

    expect(output.checked).toBe("ok");
    expect(output.parsed).toEqual({ value: 42 });
    expect(output.tempContent).toEqual({ hello: "world" });
    let tempStatError: unknown = null;
    try {
      await fs.stat(String(output.tempPath));
    } catch (error) {
      tempStatError = error;
    }
    expect(tempStatError).toBeInstanceOf(Error);
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

  test("built-in git reviewContext and preflight summarize dirty worktrees", async () => {
    using tmp = new DisposableTempDir("workflow-action-git-review-context");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "mux@example.com"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "Mux"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "initial\n", "utf-8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "changed\n", "utf-8");
    await fs.writeFile(path.join(repoRoot, "untracked.txt"), "new\n", "utf-8");
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const runner = new WorkflowActionRunner();
    const reviewContextAction = await registry.resolveAction("git.reviewContext", {
      projectTrusted: false,
    });

    const reviewContext = await runner.execute(reviewContextAction, {
      input: { includeCommits: true, diffCharBudget: 10_000 },
      cwd: repoRoot,
      timeoutMs: 30_000,
      artifactDir: path.join(tmp.path, "artifacts-review"),
    });
    const output = expectObjectRecord(reviewContext.output);
    const flags = expectObjectRecord(output.flags);
    const changedFiles = expectObjectRecord(output.changedFiles);
    const rendered = expectObjectRecord(output.rendered);

    expect(flags.hasUncommittedChanges).toBe(true);
    expect(flags.hasUntrackedChanges).toBe(true);
    expect(changedFiles.all).toEqual(expect.arrayContaining(["tracked.txt", "untracked.txt"]));
    expect(rendered.snapshotMarkdown).toContain("Repository status");

    const metadataOnlyReviewContext = await runner.execute(reviewContextAction, {
      input: { diffCharBudget: 0 },
      cwd: repoRoot,
      timeoutMs: 30_000,
      artifactDir: path.join(tmp.path, "artifacts-review-metadata-only"),
    });
    const metadataOnlyOutput = expectObjectRecord(metadataOnlyReviewContext.output);
    const metadataOnlyDiff = expectObjectRecord(metadataOnlyOutput.diff);
    expect(metadataOnlyDiff.unstaged).toBe("");
    expect(expectObjectRecord(metadataOnlyDiff.truncated).unstaged).toBe(true);
    expect(expectObjectRecord(metadataOnlyOutput.changedFiles).all).toEqual(
      expect.arrayContaining(["tracked.txt", "untracked.txt"])
    );

    const preflightAction = await registry.resolveAction("git.preflight", {
      projectTrusted: false,
    });
    const preflight = await runner.execute(preflightAction, {
      input: { requireClean: true },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-preflight"),
    });
    const preflightOutput = expectObjectRecord(preflight.output);

    expect(preflightOutput.ok).toBe(false);
    expect(preflightOutput.reason).toContain("dirty");
  }, 40_000);

  test("built-in git.reviewContext reports failures outside a git repository", async () => {
    using tmp = new DisposableTempDir("workflow-action-git-review-context-no-repo");
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const action = await registry.resolveAction("git.reviewContext", { projectTrusted: false });
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(action, {
      input: null,
      cwd: tmp.path,
      timeoutMs: 30_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    const output = expectObjectRecord(result.output);
    const failures = output.failures;
    expect(Array.isArray(failures)).toBe(true);
    const failureActions = (failures as unknown[]).map(
      (failure) => expectObjectRecord(failure).action
    );
    expect(failureActions).toContain("git.status");
    expect(failureActions).toContain("git.reviewContext");
    expect(expectObjectRecord(output.rendered).snapshotMarkdown).toContain("Git context warnings");
  }, 40_000);

  test("built-in git.status skips ignored files unless requested", async () => {
    using tmp = new DisposableTempDir("workflow-action-git-status-ignored");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(path.join(repoRoot, "ignored"), { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, ".gitignore"), "ignored/\n", "utf-8");
    await fs.writeFile(path.join(repoRoot, "ignored", "generated.txt"), "ignored\n", "utf-8");
    await fs.writeFile(path.join(repoRoot, "untracked.txt"), "new\n", "utf-8");
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const action = await registry.resolveAction("git.status", { projectTrusted: false });
    const runner = new WorkflowActionRunner();

    const defaultStatus = await runner.execute(action, {
      input: null,
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-default"),
    });
    const statusWithIgnored = await runner.execute(action, {
      input: { includeIgnored: true },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-ignored"),
    });

    expect(expectObjectRecord(defaultStatus.output).ignored).toEqual([]);
    expect(expectObjectRecord(defaultStatus.output).untracked).toContain("untracked.txt");
    expect(expectObjectRecord(statusWithIgnored.output).ignored).toContain("ignored/generated.txt");
  }, 10_000);

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

  test("detects exports in sources containing regex literals", async () => {
    using tmp = new DisposableTempDir("workflow-action-regex-mask");
    const sourcePath = path.join(tmp.path, "regex.js");
    // Regression: "//" inside regex literals (URL matchers, comment strippers) was
    // misread as a line comment, swallowing the rest of the line. That unbalanced the
    // masked source and hid the execute export ("must export an execute function").
    const source = `
      module.exports.metadata = { version: 1, description: "Regex", effect: "read" };
      function stripBlockComments(text) {
        return String(text).replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");
      }
      function isHttpUrl(text) {
        return /^https?:\\/\\//.test(text);
      }
      const half = 10 / 2;
      module.exports.execute = async function (input) {
        return { url: isHttpUrl(String(input)), ratio: stripBlockComments(String(input)).length / half };
      };
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const description = await runner.describe(createAction(sourcePath, source));

    expect(description.metadata.description).toBe("Regex");
    expect(description.hasReconcile).toBe(false);
  });

  test("treats division after masked literals as division, even on one line", async () => {
    using tmp = new DisposableTempDir("workflow-action-division-mask");
    // Regression (Codex review): masking strings to spaces erased the value token
    // before "/", so division after a string/template literal was misread as a regex
    // start. With a single "/" in a one-line (minified) source, everything after it —
    // including the execute export — was masked away, blocking a valid action.
    const sources = [
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; const n = "10" / 2; module.exports.execute = async () => ({ n });`,
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; const n = \`10\` / 2; module.exports.execute = async () => ({ n });`,
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; let count = 4; const n = count++ / 2; module.exports.execute = async () => ({ n });`,
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; const n = { valueOf() { return 10; } } / 2; module.exports.execute = async () => ({ n });`,
      // Object-literal division followed by a real regex on the same line: the later
      // "/" must not be mistaken for the closing delimiter of a regex starting at the
      // division slash (which would mask the execute export between them).
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; const n = { valueOf() { return 10; } } / 2; module.exports.execute = async () => /x/.test("x");`,
      // Counter-case: "}" closing a block (not an object literal) still starts a regex;
      // the "(" inside the character class must stay masked or it corrupts paren depth.
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; if (globalThis.x) {} /^[(]/.test("a"); module.exports.execute = async () => ({ ok: true });`,
      // Object literals introduced by ternary/logical operators are values too.
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; const n = globalThis.cond ? { valueOf() { return 10; } } / 2 : 0; module.exports.execute = async () => /x/.test("x");`,
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; const n = globalThis.flag || { valueOf() { return 10; } } / 2; module.exports.execute = async () => /x/.test("x");`,
      // Counter-case: ")" closing a control-statement header is statement position, so
      // a regex (not division) follows; its "(" must stay masked.
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; if (globalThis.x) /^[(]/.test("a"); module.exports.execute = async () => ({ ok: true });`,
      // A masked regex literal is itself a value: dividing it keeps the next "/" as
      // division instead of pairing with a later regex and masking across.
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; const n = /x/ / 2; module.exports.execute = async () => /y/.test("y");`,
      // Counter-case: a regex literal as the right operand of division still gets
      // masked (its "(" and "[" must not corrupt depth counting).
      `module.exports.metadata = { version: 1, description: "Division", effect: "read" }; const a = 4; const q = a / /([(])/.source.length; module.exports.execute = async () => ({ q });`,
    ];
    const runner = new WorkflowActionRunner();
    for (const [index, source] of sources.entries()) {
      const sourcePath = path.join(tmp.path, `division-${index}.js`);
      await fs.writeFile(sourcePath, source, "utf-8");

      const description = await runner.describe(createAction(sourcePath, source));

      expect(description.metadata.description).toBe("Division");
    }
  });

  test("describes reconcile aliases that point at execute", async () => {
    using tmp = new DisposableTempDir("workflow-action-reconcile-alias");
    const sources = [
      `module.exports.metadata = { version: 1, description: "Alias", effect: "workspace" };
module.exports.execute = async function (input) { return { input, reconciled: true }; };
module.exports.reconcile = module.exports.execute;
`,
      `export const metadata = { version: 1, description: "Alias", effect: "workspace" };
export async function execute(input) { return { input, reconciled: true }; }
export const reconcile = execute;
`,
    ];
    const runner = new WorkflowActionRunner();
    for (const [index, source] of sources.entries()) {
      const sourcePath = path.join(tmp.path, `alias-${index}.js`);
      await fs.writeFile(sourcePath, source, "utf-8");
      const action = createAction(sourcePath, source);

      const description = await runner.describe(action);
      const result = await runner.reconcile(action, {
        input: { index },
        cwd: tmp.path,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, `artifacts-${index}`),
      });

      expect(description.hasReconcile).toBe(true);
      expect(result.output).toEqual({ input: { index }, reconciled: true });
    }
  });

  test("describes every built-in workflow action", async () => {
    // Built-in sources must always pass static describe validation; a failure here
    // surfaces in the UI as a "blocked" action (e.g. security.hashFiles, whose regex
    // literals previously broke the static export detection).
    using tmp = new DisposableTempDir("workflow-action-built-in-describe");
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const runner = new WorkflowActionRunner();

    const actions = await registry.listActions({ projectTrusted: false });

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      const resolved = await registry.resolveAction(action.name, { projectTrusted: false });
      const description = await runner.describe(resolved);
      expect(description.metadata.description).toBeTruthy();
      if (
        [
          "github.getIssueAutomationState",
          "github.getIssueConversation",
          "github.listIssues",
          "github.verifyIssueCommentUrl",
        ].includes(action.name)
      ) {
        expect(description.metadata.effect).toBe("read");
      }
      if (
        [
          "github.ensureIssueLabels",
          "github.upsertIssueComment",
          "security.writeEvidenceBundle",
          "security.writeState",
          "security.writeThreatModel",
        ].includes(action.name)
      ) {
        expect(description.hasReconcile).toBe(true);
      }
      if (action.name.startsWith("git.") || action.name.startsWith("github.")) {
        const outputSchema = expectObjectRecord(description.metadata.outputSchema);
        expect(Object.keys(expectObjectRecord(outputSchema.properties)).length).toBeGreaterThan(0);
        const inputSchema = expectObjectRecord(description.metadata.inputSchema);
        expect(Object.keys(expectObjectRecord(inputSchema.properties)).length).toBeGreaterThan(0);
      }
    }
  });

  test("executes exported actions after control-header regex literals", async () => {
    using tmp = new DisposableTempDir("workflow-action-control-regex");
    const sourcePath = path.join(tmp.path, "control-regex.js");
    const source = `
      const flag = true;
      if (flag) /\\{/.test("{");
      export const metadata = { version: 1, description: "Control regex", effect: "read" };
      export async function execute() { return { ok: true }; }
    `;
    await fs.writeFile(sourcePath, source, "utf-8");
    const runner = new WorkflowActionRunner();

    const result = await runner.execute(createAction(sourcePath, source), {
      input: null,
      cwd: tmp.path,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts"),
    });

    expect(result.output).toEqual({ ok: true });
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

  test("built-in security actions write scanner state only under .mux/security", async () => {
    using tmp = new DisposableTempDir("workflow-action-security-state");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const runner = new WorkflowActionRunner();
    const threatModelAction = await registry.resolveAction("security.writeThreatModel", {
      projectTrusted: false,
    });
    const writeStateAction = await registry.resolveAction("security.writeState", {
      projectTrusted: false,
    });

    await runner.execute(threatModelAction, {
      input: {
        markdown: "# Security Threat Model\n\nGenerated model.",
        index: { sections: [{ id: "entrypoints", files: ["src/main.ts"] }] },
        generatedAt: "2026-06-10T00:00:00.000Z",
      },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-threat"),
    });
    await runner.execute(writeStateAction, {
      input: {
        runDirId: "run-test",
        cache: { findings: {}, coverage: {} },
        reportMarkdown: "# Security Scan\n\nNo findings.",
        structuredOutput: { findingCount: 0 },
      },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-state"),
    });

    expect(
      await fs.readFile(path.join(repoRoot, ".mux/security/threat-model.md"), "utf-8")
    ).toContain("Generated model.");
    expect(
      await fs.readFile(path.join(repoRoot, ".mux/security/threat-model.index.json"), "utf-8")
    ).toContain("entrypoints");
    expect(await fs.readFile(path.join(repoRoot, ".mux/security/cache.json"), "utf-8")).toContain(
      "mux-security-scan/v1"
    );
    expect(
      await fs.readFile(path.join(repoRoot, ".mux/security/runs/run-test/report.md"), "utf-8")
    ).toContain("No findings.");
    await expectRejects(
      fs.access(path.join(repoRoot, ".mux/threat-model.md")),
      /no such file|ENOENT/i
    );
    await expectRejects(
      fs.access(path.join(repoRoot, ".mux/security-cache.json")),
      /no such file|ENOENT/i
    );
  });

  test("built-in security actions reject unsafe paths and recover from malformed state", async () => {
    using tmp = new DisposableTempDir("workflow-action-security-safety");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(path.join(repoRoot, ".mux/security"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".mux/security/cache.json"), "{not json", "utf-8");
    await fs.writeFile(path.join(repoRoot, "safe.txt"), "safe", "utf-8");
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const runner = new WorkflowActionRunner();
    const loadStateAction = await registry.resolveAction("security.loadState", {
      projectTrusted: false,
    });
    const hashFilesAction = await registry.resolveAction("security.hashFiles", {
      projectTrusted: false,
    });
    const writeStateAction = await registry.resolveAction("security.writeState", {
      projectTrusted: false,
    });
    const writeEvidenceAction = await registry.resolveAction("security.writeEvidenceBundle", {
      projectTrusted: false,
    });

    const loaded = await runner.execute(loadStateAction, {
      input: null,
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-load"),
    });
    expect(loaded.output).toMatchObject({ securityRoot: ".mux/security" });
    expect(JSON.stringify(loaded.output)).toContain("cache.json");

    await expectRejects(
      runner.execute(hashFilesAction, {
        input: { files: ["../escape.txt"] },
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts-hash"),
      }),
      /traverse|relative path/
    );
    await expectRejects(
      runner.execute(writeStateAction, {
        input: { runDirId: "../escape", cache: {} },
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts-write"),
      }),
      /letters, numbers|traverse|relative/
    );
    await expectRejects(
      runner.execute(writeEvidenceAction, {
        input: {
          findingId: "mux-sec-safe",
          evidence: {},
          pocScripts: { "../escape.sh": "echo unsafe" },
        },
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts-evidence-unsafe"),
      }),
      /traverse|relative path/
    );
  });

  test("built-in security writes remain git-ignored and reject reserved artifact identities", async () => {
    using tmp = new DisposableTempDir("workflow-action-security-gitignore");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "tracked\n", "utf-8");
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await runGit(repoRoot, ["add", "tracked.txt"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);

    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const runner = new WorkflowActionRunner();
    const threatModelAction = await registry.resolveAction("security.writeThreatModel", {
      projectTrusted: false,
    });
    const evidenceAction = await registry.resolveAction("security.writeEvidenceBundle", {
      projectTrusted: false,
    });
    const writeStateAction = await registry.resolveAction("security.writeState", {
      projectTrusted: false,
    });

    await runner.execute(threatModelAction, {
      input: { markdown: "# Generated", index: { sections: [] }, generatedAt: "test" },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-threat-ignored"),
    });
    await runner.execute(evidenceAction, {
      input: { findingId: "mux-sec-safe", evidence: { verdict: "verified" }, transcript: "ok" },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-evidence-ignored"),
    });
    const firstStateWrite = await runner.execute(writeStateAction, {
      input: { cache: { findings: {}, coverage: {} }, reportMarkdown: "# Report" },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-state-ignored"),
    });
    const secondStateWrite = await runner.execute(writeStateAction, {
      input: { cache: { findings: {}, coverage: {} }, reportMarkdown: "# Report" },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-state-ignored-repeat"),
    });
    expect(expectObjectRecord(firstStateWrite.output).runDir).toBe(
      expectObjectRecord(secondStateWrite.output).runDir
    );

    expect(await fs.readFile(path.join(repoRoot, ".mux/security/.gitignore"), "utf-8")).toBe("*\n");
    expect(await readGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"])).toBe("");

    await expectRejects(
      runner.execute(evidenceAction, {
        input: { findingId: "..", evidence: {} },
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts-evidence-dot-id"),
      }),
      /letters or numbers|reserved/
    );
    await expectRejects(
      runner.execute(writeStateAction, {
        input: { runDirId: "latest", cache: {} },
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts-state-latest"),
      }),
      /reserved id latest/
    );
    await expectRejects(
      runner.execute(evidenceAction, {
        input: {
          findingId: "mux-sec-safe",
          evidence: {},
          pocScripts: { "evidence.json": "echo overwrite" },
        },
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts-evidence-reserved"),
      }),
      /reserved evidence file/
    );
    await fs.writeFile(
      path.join(tmp.path, "outside-threat-model.md"),
      "<!-- mux-security-generated:start -->\noutside\n<!-- mux-security-generated:end -->\n",
      "utf-8"
    );
    await fs.rm(path.join(repoRoot, ".mux/security/threat-model.md"));
    await fs.symlink(
      path.join(tmp.path, "outside-threat-model.md"),
      path.join(repoRoot, ".mux/security/threat-model.md")
    );
    await expectRejects(
      runner.execute(threatModelAction, {
        input: { markdown: "# Regenerated", index: { sections: [] }, generatedAt: "test" },
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts-threat-symlink"),
      }),
      /escapes \.mux\/security/
    );
  });

  test("built-in security hashes include formatting-stable JS/TS semantic fingerprints", async () => {
    using tmp = new DisposableTempDir("workflow-action-security-semantic-hash");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "src", "compact.ts"),
      "export function allow(user: User) { return user.admin && user.active; }\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(repoRoot, "src", "formatted.ts"),
      "export function allow(user: User) {\n  // formatting-only drift\n  return user.admin && user.active;\n}\n",
      "utf-8"
    );
    await fs.mkdir(path.join(repoRoot, "..config"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "..config", "auth.ts"),
      "export const auth = true;\n",
      "utf-8"
    );
    await fs.writeFile(
      path.join(tmp.path, "outside-secret.ts"),
      "export const secret = true;\n",
      "utf-8"
    );
    await fs.symlink(
      path.join(tmp.path, "outside-secret.ts"),
      path.join(repoRoot, "secret-link.ts")
    );
    await fs.writeFile(path.join(repoRoot, "root.ts"), "export const root = true;\n", "utf-8");
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const runner = new WorkflowActionRunner();
    const hashAction = await registry.resolveAction("security.hashFiles", {
      projectTrusted: false,
    });

    const result = await runner.execute(hashAction, {
      input: {
        files: [
          "src/compact.ts",
          "src/formatted.ts",
          "..config/auth.ts",
          "root.ts",
          "missing/none.ts",
        ],
      },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-semantic-hash"),
    });

    const output = expectObjectRecord(result.output);
    const files = output.files;
    expect(Array.isArray(files)).toBe(true);
    if (!Array.isArray(files)) throw new Error("expected hashFiles files output");
    const compact = expectObjectRecord(files[0]);
    const formatted = expectObjectRecord(files[1]);
    const dotPrefixed = expectObjectRecord(files[2]);
    const root = expectObjectRecord(files[3]);
    const missing = expectObjectRecord(files[4]);
    expect(compact.sha256).not.toBe(formatted.sha256);
    expect(compact.semanticSha256).toMatch(/^sha256:/);
    expect(compact.semanticSha256).toBe(formatted.semanticSha256);
    expect(compact.semanticSections).toEqual(formatted.semanticSections);
    expect(dotPrefixed).toMatchObject({ path: "..config/auth.ts", missing: false });
    expect(root).toMatchObject({ path: "root.ts", missing: false });
    expect(root.semanticSha256).toMatch(/^sha256:/);
    expect(missing).toMatchObject({ path: "missing/none.ts", sha256: null, missing: true });
    expect(Array.isArray(compact.semanticSections)).toBe(true);
    await expectRejects(
      runner.execute(hashAction, {
        input: { files: ["secret-link.ts"] },
        cwd: repoRoot,
        timeoutMs: 10_000,
        artifactDir: path.join(tmp.path, "artifacts-semantic-hash-symlink"),
      }),
      /escapes the workspace/
    );
  });

  test("built-in security matching uses strong fingerprints without merging by rule alone", async () => {
    using tmp = new DisposableTempDir("workflow-action-security-match");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const runner = new WorkflowActionRunner();
    const matchAction = await registry.resolveAction("security.matchFindings", {
      projectTrusted: false,
    });

    const result = await runner.execute(matchAction, {
      input: {
        cache: {
          findings: {
            "mux-sec-existing": {
              ruleId: "typescript/xss/unsafe-html",
              fingerprints: {
                primary: "sha256:old-primary",
                semanticAst: "sha256:same-ast",
              },
              status: "verified",
              aliases: ["sha256:older-primary"],
            },
            "mux-sec-unresolved": {
              ruleId: "typescript/xss/unsafe-html",
              status: "unverified",
              fingerprints: {
                primary: "sha256:unresolved-primary",
              },
            },
            "mux-sec-fixed": {
              ruleId: "typescript/xss/unsafe-html",
              status: "fixed",
              proof: { state: "verified" },
              fingerprints: {
                primary: "sha256:fixed-primary",
              },
            },
            "mux-sec-suppressed-cache": {
              ruleId: "typescript/xss/unsafe-html",
              status: "accepted_risk",
              fingerprints: {
                primary: "sha256:suppressed-cache-primary",
              },
              proof: { state: "unverified" },
            },
            "mux-sec-other": {
              ruleId: "typescript/xss/unsafe-html",
              fingerprints: {
                primary: "sha256:other-primary",
                semanticAst: "sha256:other-ast",
              },
            },
          },
        },
        candidates: [
          {
            id: "candidate-moved",
            ruleId: "typescript/xss/unsafe-html",
            fingerprints: {
              primary: "sha256:new-primary",
              semanticAst: "sha256:same-ast",
            },
          },
          {
            id: "candidate-new",
            ruleId: "typescript/xss/unsafe-html",
            fingerprints: {
              primary: "sha256:fresh-primary",
              semanticAst: "sha256:fresh-ast",
            },
          },
          {
            id: "candidate-unresolved",
            ruleId: "typescript/xss/unsafe-html",
            fingerprints: {
              primary: "sha256:unresolved-primary",
            },
          },
          {
            id: "candidate-fixed-regressed",
            ruleId: "typescript/xss/unsafe-html",
            fingerprints: {
              primary: "sha256:fixed-primary",
            },
          },
          {
            id: "candidate-suppressed-cache",
            ruleId: "typescript/xss/unsafe-html",
            fingerprints: {
              primary: "sha256:suppressed-cache-primary",
            },
          },
          {
            id: "candidate-suppressed",
            ruleId: "typescript/xss/unsafe-html",
            fingerprints: {
              primary: "sha256:suppressed-primary",
              semanticAst: "sha256:suppressed-ast",
            },
          },
        ],
        overrides: {
          overrides: {
            "candidate-suppressed": { status: "accepted_risk", reason: "reviewed by owner" },
          },
        },
      },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-match"),
    });

    expect(result.output).toMatchObject({
      decisions: [
        {
          candidateId: "candidate-moved",
          match: "strong",
          findingId: "mux-sec-existing",
        },
        {
          candidateId: "candidate-new",
          match: "new",
          findingId: "candidate-new",
        },
        {
          candidateId: "candidate-unresolved",
          match: "exact",
          findingId: "mux-sec-unresolved",
        },
        {
          candidateId: "candidate-fixed-regressed",
          match: "exact",
          findingId: "mux-sec-fixed",
        },
        {
          candidateId: "candidate-suppressed-cache",
          match: "exact",
          findingId: "mux-sec-suppressed-cache",
        },
        {
          candidateId: "candidate-suppressed",
          match: "new",
          findingId: "candidate-suppressed",
          override: { status: "accepted_risk", reason: "reviewed by owner", expiresAt: null },
        },
      ],
      verify: ["candidate-new", "mux-sec-unresolved", "mux-sec-fixed"],
      aliasUpdates: [
        {
          findingId: "mux-sec-existing",
          addAlias: "sha256:new-primary",
        },
      ],
    });
  });

  test("built-in security evidence action writes proof bundles with digests", async () => {
    using tmp = new DisposableTempDir("workflow-action-security-evidence");
    const repoRoot = path.join(tmp.path, "repo");
    await fs.mkdir(repoRoot, { recursive: true });
    const registry = new WorkflowActionRegistry({
      projectRoot: path.join(tmp.path, "project-actions"),
      globalRoot: path.join(tmp.path, "global-actions"),
    });
    const runner = new WorkflowActionRunner();
    const evidenceAction = await registry.resolveAction("security.writeEvidenceBundle", {
      projectTrusted: false,
    });

    const result = await runner.execute(evidenceAction, {
      input: {
        findingId: "mux-sec-test",
        evidence: { verdict: "verified", assertions: ["blocked unauthorized access"] },
        transcript: "verified transcript",
        baseline: { vulnerable: true },
        postState: { vulnerable: false },
        pocScripts: {
          "vul-run.sh": "#!/bin/sh\necho vulnerable\n",
          "fix-run.sh": "#!/bin/sh\necho fixed\n",
        },
      },
      cwd: repoRoot,
      timeoutMs: 10_000,
      artifactDir: path.join(tmp.path, "artifacts-evidence"),
    });

    expect(result.output).toMatchObject({
      findingId: "mux-sec-test",
      evidencePath: ".mux/security/evidence/mux-sec-test/evidence.json",
    });
    const evidenceJson = await fs.readFile(
      path.join(repoRoot, ".mux/security/evidence/mux-sec-test/evidence.json"),
      "utf-8"
    );
    expect(evidenceJson).toContain("blocked unauthorized access");
    expect(evidenceJson).toContain("sha256:");
    expect(
      await fs.readFile(
        path.join(repoRoot, ".mux/security/evidence/mux-sec-test/transcript.txt"),
        "utf-8"
      )
    ).toBe("verified transcript");
    expect(
      await fs.readFile(
        path.join(repoRoot, ".mux/security/evidence/mux-sec-test/vul-run.sh"),
        "utf-8"
      )
    ).toContain("vulnerable");
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
