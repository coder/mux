import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { parseWorkflowArgs, workflowExperimentEnabled } from "./workflow";

const BUN_EXECUTABLE = process.execPath;
const WORKFLOW_ENTRY = path.join(import.meta.dir, "workflow.ts");
const INDEX_ENTRY = path.join(import.meta.dir, "index.ts");

async function getRejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected promise to reject");
}

async function trustProject(muxRoot: string, repo: string): Promise<void> {
  await Bun.$`${BUN_EXECUTABLE} -e ${`import { Config } from "./src/node/config"; const c = new Config(); const cfg = c.loadConfigOrDefault(); cfg.projects.set(process.argv[1], { workspaces: [], trusted: true }); await c.saveConfig(cfg);`} ${repo}`
    .env({ ...process.env, MUX_ROOT: muxRoot })
    .quiet();
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
    expect(await parseWorkflowArgs({ argsStdin: true, stdinText: '{"fromStdin":true}' })).toEqual({
      fromStdin: true,
    });
    expect(await parseWorkflowArgs({ arg: ["strict=true", "count=2", "label=review"] })).toEqual({
      strict: true,
      count: 2,
      label: "review",
    });
  });

  test("CLI commands reject when dynamic-workflows is not enabled", async () => {
    using tmp = new DisposableTempDir("workflow-cli-experiment");
    const repo = path.join(tmp.path, "repo");
    const muxRoot = path.join(tmp.path, "mux-root");
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });

    const result = await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} list --dir ${repo}`
      .env({ ...process.env, MUX_ROOT: muxRoot })
      .nothrow()
      .quiet();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "mux workflow requires the dynamic-workflows experiment"
    );
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
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} run echo-review --dir ${repo} -e dynamic-workflows`
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
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} run echo-review --dir ${repo} --runtime worktree -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .nothrow()
        .quiet();

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "mux workflow currently supports only local runtime"
    );
  });

  test("CLI list warns on stderr when untrusted project workflows are skipped", async () => {
    using tmp = new DisposableTempDir("workflow-cli-skip-warning");
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
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} list --dir ${repo} -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .quiet();

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).not.toContain("echo-review");
    const stderr = result.stderr.toString();
    expect(stderr).toContain("skipped project workflows");
    expect(stderr).toContain("not trusted");
  }, 15_000);

  test("CLI resolves trust through linked git worktrees of a trusted project", async () => {
    using tmp = new DisposableTempDir("workflow-cli-worktree");
    // realpath: git reports physical paths (macOS /var -> /private/var), and the
    // worktree trust fallback compares them against config keys by exact path.
    const base = await fs.realpath(tmp.path);
    const repo = path.join(base, "repo");
    const muxRoot = path.join(base, "mux-root");
    const worktree = path.join(base, "worktree");
    await fs.mkdir(path.join(repo, ".mux", "workflows"), { recursive: true });
    await fs.mkdir(muxRoot, { recursive: true });
    await fs.writeFile(
      path.join(repo, ".mux", "workflows", "echo-review.js"),
      `// description: Echo review input
export default function workflow() { return { reportMarkdown: "from worktree" }; }
`,
      "utf-8"
    );
    await Bun.$`git init`.cwd(repo).quiet();
    await Bun.$`git config user.email dogfood@example.com`.cwd(repo).quiet();
    await Bun.$`git config user.name Dogfood`.cwd(repo).quiet();
    await Bun.$`git add .`.cwd(repo).quiet();
    await Bun.$`git commit -m init`.cwd(repo).quiet();
    await Bun.$`git worktree add ${worktree} -b feature`.cwd(repo).quiet();

    // Trust only the main repository path; the worktree checkout itself has no
    // trust entry, matching how mux config keys trust for workspace worktrees.
    await trustProject(muxRoot, repo);

    const result =
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} list --dir ${worktree} -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .quiet();

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("echo-review\tproject\tEcho review input");
    expect(result.stderr.toString()).not.toContain("skipped project workflows");
  }, 15_000);

  // Explicit timeout: this end-to-end test boots seven separate CLI subprocesses
  // (list/show/run variants) plus git setup; the default 5s budget is marginal
  // even locally and routinely overruns on loaded CI runners.
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
    await fs.writeFile(
      path.join(repo, ".mux", "workflows", "explode.js"),
      `// description: Throw from workflow
export default function workflow() { throw new Error("boom"); }
`,
      "utf-8"
    );

    await trustProject(muxRoot, repo);

    const routedListOutput =
      await Bun.$`${BUN_EXECUTABLE} ${INDEX_ENTRY} workflow list --dir ${repo} -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .text();
    expect(routedListOutput).toContain("echo-review\tproject\tEcho review input");

    const listOutput =
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} list --dir ${repo} -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .text();
    expect(listOutput).toContain("echo-review\tproject\tEcho review input");
    const showOutput =
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} show echo-review --dir ${repo} --source -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .text();
    expect(showOutput).toContain("scope: project");
    expect(showOutput).toContain("description: Echo review input");
    expect(showOutput).toContain("export default function workflow");

    const runOutput =
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} run echo-review --dir ${repo} --args-json ${'{"base":"main"}'} --json -e dynamic-workflows`
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

    const quietOutput =
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} run echo-review --dir ${repo} "hello" --quiet -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .text();
    expect(quietOutput).toBe('Echo: {"input":"hello"}\n');

    const stdinProc = Bun.spawn(
      [
        BUN_EXECUTABLE,
        WORKFLOW_ENTRY,
        "run",
        "echo-review",
        "--dir",
        repo,
        "--args-stdin",
        "--json",
        "-e",
        "dynamic-workflows",
      ],
      {
        env: { ...process.env, MUX_ROOT: muxRoot },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    stdinProc.stdin.write('{"fromStdin":true}');
    await stdinProc.stdin.end();
    const [stdinStdout, stdinStderr, stdinExitCode] = await Promise.all([
      new Response(stdinProc.stdout).text(),
      new Response(stdinProc.stderr).text(),
      stdinProc.exited,
    ]);
    expect(stdinExitCode).toBe(0);
    expect(stdinStderr).toBe("");
    const stdinEvent = JSON.parse(stdinStdout.trim()) as unknown;
    expect(stdinEvent).toMatchObject({
      type: "result",
      status: "completed",
      result: { reportMarkdown: 'Echo: {"fromStdin":true}' },
    });

    const failedRun =
      await Bun.$`${BUN_EXECUTABLE} ${WORKFLOW_ENTRY} run explode --dir ${repo} -e dynamic-workflows`
        .env({ ...process.env, MUX_ROOT: muxRoot })
        .nothrow()
        .quiet();
    expect(failedRun.exitCode).toBe(1);
  }, 30_000);
});
