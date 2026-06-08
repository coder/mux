import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  parseWorkflowArgs,
  resolveWorkflowProjectDir,
  workflowExperimentEnabled,
} from "./workflow";

async function getRejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected promise to reject");
}

describe("mux workflow CLI helpers", () => {
  test("requires dynamic-workflows experiment unless persisted override is on", () => {
    expect(workflowExperimentEnabled([], "default")).toBe(false);
    expect(workflowExperimentEnabled(["dynamic-workflows"], "default")).toBe(true);
    expect(workflowExperimentEnabled([], "on")).toBe(true);
    expect(workflowExperimentEnabled(["dynamic-workflows"], "off")).toBe(true);
  });

  test("maps positional workflow input to an args object", async () => {
    const args = await parseWorkflowArgs({ positionalInput: ["review", "staged", "changes"] });

    expect(args).toEqual({ input: "review staged changes" });
  });

  test("rejects ambiguous structured args modes", async () => {
    expect(
      await getRejectedMessage(
        parseWorkflowArgs({ positionalInput: ["hi"], argsJson: '{"base":"main"}' })
      )
    ).toContain("positional input cannot be combined");
    expect(
      await getRejectedMessage(parseWorkflowArgs({ argsJson: "{}", argsFile: "args.json" }))
    ).toContain("Only one structured args mode");
  });

  test("parses JSON args modes and --arg scalars", async () => {
    using tmp = new DisposableTempDir("workflow-cli-args");
    const argsFile = path.join(tmp.path, "args.json");
    await fs.writeFile(argsFile, '{"fromFile":true}', "utf-8");

    expect(await parseWorkflowArgs({ argsJson: '{"base":"main"}' })).toEqual({
      base: "main",
    });
    expect(await parseWorkflowArgs({ argsFile })).toEqual({ fromFile: true });
    expect(await parseWorkflowArgs({ arg: ["strict=true", "count=2", "label=review"] })).toEqual({
      strict: true,
      count: 2,
      label: "review",
    });
  });

  test("normalizes implicit cwd to git root but preserves explicit --dir", async () => {
    using tmp = new DisposableTempDir("workflow-cli-dir");
    const repo = path.join(tmp.path, "repo");
    const nested = path.join(repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();

    expect(await resolveWorkflowProjectDir({ cwd: nested })).toBe(repo);
    expect(await resolveWorkflowProjectDir({ cwd: tmp.path, explicitDir: nested })).toBe(nested);
  });

  test("CLI run reports an actionable trust error for untrusted project workflows", async () => {
    using tmp = new DisposableTempDir("workflow-cli-untrusted");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, ".mux", "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(repo, ".mux", "workflows", "echo-review.js"),
      `// description: Echo review input
export default function workflow() { return { reportMarkdown: "untrusted" }; }
`,
      "utf-8"
    );

    const result =
      await Bun.$`bun src/cli/workflow.ts run echo-review --dir ${repo} -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .nothrow()
        .quiet();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Project trust is required to execute project-local workflow"
    );
  });

  test("CLI rejects non-local runtimes before running workflows", async () => {
    using tmp = new DisposableTempDir("workflow-cli-runtime");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, ".mux", "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(repo, ".mux", "workflows", "echo-review.js"),
      `// description: Echo review input
export default function workflow() { return { reportMarkdown: "should not run" }; }
`,
      "utf-8"
    );

    const result =
      await Bun.$`bun src/cli/workflow.ts run echo-review --dir ${repo} --runtime worktree -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .nothrow()
        .quiet();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "mux workflow currently supports only local runtime"
    );
  });

  test("CLI lists and runs a trusted project workflow with JSON args", async () => {
    using tmp = new DisposableTempDir("workflow-cli-e2e");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(path.join(repo, ".mux", "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await fs.writeFile(path.join(repo, "README.md"), "hello\n", "utf-8");
    await Bun.$`git add README.md`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await fs.writeFile(
      path.join(repo, ".mux", "workflows", "echo-review.js"),
      `// description: Echo review input
export default function workflow({ args }) {
  return { reportMarkdown: "Echo: " + JSON.stringify(args), structuredOutput: { ok: true, args } };
}
`,
      "utf-8"
    );

    await Bun.$`bun -e ${`import { Config } from "./src/node/config"; const c = new Config(); const cfg = c.loadConfigOrDefault(); cfg.projects.set(process.argv[1], { workspaces: [], trusted: true }); await c.saveConfig(cfg);`} ${repo}`
      .env({ ...process.env, MUX_ROOT: muxRoot })
      .quiet();

    const routedListOutput =
      await Bun.$`bun src/cli/index.ts workflow list --dir ${repo} -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .text();
    expect(routedListOutput).toContain("echo-review\tproject\tEcho review input");

    const listOutput = await Bun.$`bun src/cli/workflow.ts list --dir ${repo} -e dynamic-workflows`
      .env({ ...process.env, MUX_ROOT: muxRoot })
      .text();
    expect(listOutput).toContain("echo-review\tproject\tEcho review input");

    const runOutput =
      await Bun.$`bun src/cli/workflow.ts run echo-review --dir ${repo} --args-json ${'{"base":"main"}'} --json -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .text();
    const lines = runOutput.trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0] ?? "null") as unknown;
    expect(event).toMatchObject({
      type: "result",
      status: "completed",
      result: { reportMarkdown: 'Echo: {"base":"main"}' },
    });
  });
});
