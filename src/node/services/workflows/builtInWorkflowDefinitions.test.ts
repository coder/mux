/* eslint-disable @typescript-eslint/require-await */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { BUILT_IN_WORKFLOW_DEFINITIONS } from "./builtInWorkflowDefinitions";
import { WorkflowActionRegistry } from "./WorkflowActionRegistry";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowRunner, type WorkflowAgentSpec } from "./WorkflowRunner";

const BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS = 100;

const deepResearch = BUILT_IN_WORKFLOW_DEFINITIONS.find(
  (definition) => definition.name === "deep-research"
);

const deepReviewWorkflow = BUILT_IN_WORKFLOW_DEFINITIONS.find(
  (definition) => definition.name === "deep-review-workflow"
);

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function createNoIssueDeepReviewTaskAdapter(taskCalls: WorkflowAgentSpec[]) {
  return {
    async runAgent(spec: WorkflowAgentSpec) {
      taskCalls.push(spec);
      switch (spec.id) {
        case "scope-review-surface":
          return {
            taskId: "task_scope",
            reportMarkdown: "Scoped review target.",
            structuredOutput: {
              summary: "Review target is scoped.",
              files: [],
              riskAreas: [],
              lanes: ["correctness"],
            },
          };
        case "review-correctness":
        case "review-tests":
        case "review-architecture":
          return {
            taskId: `task_${spec.id}`,
            reportMarkdown: "No findings.",
            structuredOutput: { issues: [] },
          };
        case "triage-candidate-issues":
          return {
            taskId: "task_triage",
            reportMarkdown: "No candidates.",
            structuredOutput: { issues: [] },
          };
        case "synthesize-review":
          return {
            taskId: "task_final",
            reportMarkdown: "# Deep Review\n\nNo verified issues.",
            structuredOutput: {
              verifiedIssueCount: 0,
              verifiedIssueIds: [],
              risk: "low",
              validationPlan: [],
              discardedIssueCount: 0,
            },
          };
        default:
          throw new Error(`Unexpected deep-review step: ${spec.id}`);
      }
    },
  };
}

describe("built-in deep-research workflow", () => {
  test("coordinates staged research, verification, and final structured synthesis", async () => {
    if (!deepResearch) {
      throw new Error("Expected built-in deep-research workflow");
    }
    using tmp = new DisposableTempDir("deep-research-workflow");
    const runStore = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS,
    });
    await runStore.createRun({
      id: "wfr_deep_research",
      workspaceId: "workspace-1",
      definition: {
        name: deepResearch.name,
        description: deepResearch.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepResearch.source,
      args: { topic: "durable workflow orchestration" },
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-topic":
              return {
                taskId: "task_scope",
                reportMarkdown: "Research durable orchestration semantics.",
                structuredOutput: {
                  refinedTopic: "durable workflow orchestration",
                  questions: ["How are runs resumed?", "How are tasks verified?"],
                },
              };
            case "discover-sources":
              return {
                taskId: "task_sources",
                reportMarkdown: "Found implementation, RFC, and tests.",
                structuredOutput: {
                  sources: [
                    { title: "RFC", url: "rfc/20260529_dynamic-workflows.md", relevance: "design" },
                    {
                      title: "Runner",
                      url: "src/node/services/workflows/WorkflowRunner.ts",
                      relevance: "implementation",
                    },
                  ],
                },
              };
            case "summarize-source-0":
              return {
                taskId: "task_summary_0",
                reportMarkdown: "RFC describes journal replay and validation.",
                structuredOutput: {
                  source: "RFC",
                  summary: "Defines durable runs and replay.",
                },
              };
            case "summarize-source-1":
              return {
                taskId: "task_summary_1",
                reportMarkdown: "Runner describes replay lookup.",
                structuredOutput: {
                  source: "Runner",
                  summary: "Replays completed steps by hash.",
                },
              };
            case "extract-claims":
              return {
                taskId: "task_claims",
                reportMarkdown: "Extracted two claims.",
                structuredOutput: {
                  claims: [
                    {
                      claim: "Completed steps are reused on resume.",
                      support: "Runner step lookup",
                    },
                    {
                      claim: "Structured outputs are validated at report time.",
                      support: "outputSchema",
                    },
                  ],
                },
              };
            case "verify-claim-0":
              return {
                taskId: "task_verify_0",
                reportMarkdown: "Completed-step replay is supported.",
                structuredOutput: {
                  claim: "Completed steps are reused on resume.",
                  verdict: "supported",
                  risk: "low",
                },
              };
            case "verify-claim-1":
              return {
                taskId: "task_verify_1",
                reportMarkdown: "Structured output validation is supported.",
                structuredOutput: {
                  claim: "Structured outputs are validated at report time.",
                  verdict: "supported",
                  risk: "low",
                },
              };
            case "synthesize-report":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Research\nDurable workflows replay completed steps.",
                structuredOutput: { confidence: "medium", gaps: ["Needs UI dogfood"] },
              };
            default:
              throw new Error(`Unexpected deep-research step: ${spec.id}`);
          }
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_research");
    const run = await runStore.getRun("wfr_deep_research");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-topic",
      "discover-sources",
      "summarize-source-0",
      "summarize-source-1",
      "extract-claims",
      "verify-claim-0",
      "verify-claim-1",
      "synthesize-report",
    ]);
    expect(taskCalls.map((call) => call.agentId)).toEqual([
      "explore",
      "explore",
      "explore",
      "explore",
      "exec",
      "exec",
      "exec",
      "exec",
    ]);
    expect(taskCalls.every((call) => call.outputSchema != null)).toBe(true);
    expect(run.events.filter((event) => event.type === "phase").map((event) => event.name)).toEqual(
      [
        "scope",
        "source-discovery",
        "source-synthesis",
        "claim-extraction",
        "adversarial-verification",
        "final-synthesis",
      ]
    );
    expect(result).toEqual({
      reportMarkdown: "# Deep Research\nDurable workflows replay completed steps.",
      structuredOutput: {
        topic: "durable workflow orchestration",
        refinedTopic: "durable workflow orchestration",
        sources: [
          { title: "RFC", url: "rfc/20260529_dynamic-workflows.md", relevance: "design" },
          {
            title: "Runner",
            url: "src/node/services/workflows/WorkflowRunner.ts",
            relevance: "implementation",
          },
        ],
        claims: [
          { claim: "Completed steps are reused on resume.", support: "Runner step lookup" },
          { claim: "Structured outputs are validated at report time.", support: "outputSchema" },
        ],
        verification: [
          { claim: "Completed steps are reused on resume.", verdict: "supported", risk: "low" },
          {
            claim: "Structured outputs are validated at report time.",
            verdict: "supported",
            risk: "low",
          },
        ],
        confidence: "medium",
        gaps: ["Needs UI dogfood"],
      },
    });
  });

  test("skips empty source and claim fan-out stages", async () => {
    if (!deepResearch) {
      throw new Error("Expected built-in deep-research workflow");
    }
    using tmp = new DisposableTempDir("deep-research-empty-workflow");
    const runStore = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS,
    });
    await runStore.createRun({
      id: "wfr_deep_research_empty",
      workspaceId: "workspace-1",
      definition: {
        name: deepResearch.name,
        description: deepResearch.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepResearch.source,
      args: { topic: "obscure empty topic" },
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-topic":
              return {
                taskId: "task_scope",
                reportMarkdown: "Scoped obscure topic.",
                structuredOutput: { refinedTopic: "obscure empty topic", questions: [] },
              };
            case "discover-sources":
              return {
                taskId: "task_sources",
                reportMarkdown: "No high-signal sources found.",
                structuredOutput: { sources: [] },
              };
            case "extract-claims":
              return {
                taskId: "task_claims",
                reportMarkdown: "No claims extracted.",
                structuredOutput: { claims: [] },
              };
            case "synthesize-report":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Research\nNo sources were found.",
                structuredOutput: { confidence: "low", gaps: ["No sources found"] },
              };
            default:
              throw new Error(`Unexpected deep-research step: ${spec.id}`);
          }
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_research_empty");
    const run = await runStore.getRun("wfr_deep_research_empty");

    expect(run.status).toBe("completed");
    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-topic",
      "discover-sources",
      "extract-claims",
      "synthesize-report",
    ]);
    expect(taskCalls.map((call) => call.agentId)).toEqual(["explore", "explore", "exec", "exec"]);
    expect(result).toMatchObject({
      structuredOutput: {
        sources: [],
        claims: [],
        verification: [],
      },
    });
  });

  test("caps model-produced deep-research fan-out", async () => {
    if (!deepResearch) {
      throw new Error("Expected built-in deep-research workflow");
    }
    using tmp = new DisposableTempDir("deep-research-capped-workflow");
    const runStore = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS,
    });
    await runStore.createRun({
      id: "wfr_deep_research_capped",
      workspaceId: "workspace-1",
      definition: {
        name: deepResearch.name,
        description: deepResearch.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepResearch.source,
      args: { topic: "fanout cap" },
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          if (spec.id === "scope-topic") {
            return {
              taskId: "task_scope",
              reportMarkdown: "Scoped.",
              structuredOutput: { refinedTopic: "fanout cap", questions: ["How much fanout?"] },
            };
          }
          if (spec.id === "discover-sources") {
            return {
              taskId: "task_sources",
              reportMarkdown: "Many sources.",
              structuredOutput: {
                sources: Array.from({ length: 20 }, (_value, index) => ({
                  title: `Source ${index}`,
                  url: `source-${index}.md`,
                  relevance: "fixture",
                })),
              },
            };
          }
          if (spec.id.startsWith("summarize-source-")) {
            return {
              taskId: `task_${spec.id}`,
              reportMarkdown: spec.id,
              structuredOutput: { source: spec.id, summary: "summary" },
            };
          }
          if (spec.id === "extract-claims") {
            return {
              taskId: "task_claims",
              reportMarkdown: "Many claims.",
              structuredOutput: {
                claims: Array.from({ length: 20 }, (_value, index) => ({
                  claim: `Claim ${index}`,
                  support: "fixture",
                })),
              },
            };
          }
          if (spec.id.startsWith("verify-claim-")) {
            return {
              taskId: `task_${spec.id}`,
              reportMarkdown: spec.id,
              structuredOutput: { claim: spec.id, verdict: "supported", risk: "low" },
            };
          }
          if (spec.id === "synthesize-report") {
            return {
              taskId: "task_final",
              reportMarkdown: "# Capped",
              structuredOutput: { confidence: "medium", gaps: [] },
            };
          }
          throw new Error(`Unexpected deep-research step: ${spec.id}`);
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_research_capped");
    const callIds = taskCalls.map((call) => call.id);

    expect(callIds.filter((id) => id.startsWith("summarize-source-")).length).toBe(16);
    expect(callIds.filter((id) => id.startsWith("verify-claim-")).length).toBe(16);
    expect(callIds).not.toContain("summarize-source-16");
    expect(callIds).not.toContain("verify-claim-16");
    const structuredOutput = (
      result as {
        structuredOutput: { sources: unknown[]; claims: unknown[]; verification: unknown[] };
      }
    ).structuredOutput;
    expect(structuredOutput.sources).toHaveLength(16);
    expect(structuredOutput.claims).toHaveLength(16);
    expect(structuredOutput.verification).toHaveLength(16);
  }, 10_000);
});

describe("built-in deep-review-workflow", () => {
  test("coordinates scoped review lanes, adversarial verification, and final synthesis", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow");
    const runStore = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: BUILT_IN_WORKFLOW_TEST_STALE_LEASE_MS,
    });
    await runStore.createRun({
      id: "wfr_deep_review_workflow",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: {
        input: "PR #123",
        files: ["src/service.ts"],
        instructions: "Focus on correctness.",
        maxCandidates: 2,
      },
      now: "2026-05-29T00:00:00.000Z",
    });

    const issue = {
      id: "correctness-missing-await",
      severity: "P1",
      category: "correctness",
      title: "Missing await drops write failures",
      rationale: "The service reports success before persistence completes.",
      evidence: "src/service.ts calls persist() without awaiting it.",
      filePaths: ["src/service.ts"],
      suggestedFix: "Await persist() before returning success.",
      validation: "Add a failing persistence regression test.",
      confidence: "high",
    };
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-review-surface":
              return {
                taskId: "task_scope",
                reportMarkdown: "Review service changes.",
                structuredOutput: {
                  summary: "PR touches persistence service code.",
                  files: ["src/service.ts"],
                  riskAreas: ["async persistence"],
                  lanes: ["correctness", "tests", "security-reliability"],
                },
              };
            case "review-correctness":
              return {
                taskId: "task_correctness",
                reportMarkdown: "Found missing await.",
                structuredOutput: { issues: [issue] },
              };
            case "review-tests":
            case "review-security-reliability":
            case "review-architecture":
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: "No additional findings.",
                structuredOutput: { issues: [] },
              };
            case "triage-candidate-issues":
              return {
                taskId: "task_triage",
                reportMarkdown: "One actionable issue remains.",
                structuredOutput: { issues: [issue] },
              };
            case "verify-issue-0":
              return {
                taskId: "task_verify",
                reportMarkdown: "Issue is valid.",
                structuredOutput: {
                  issueId: "correctness-missing-await",
                  verdict: "valid",
                  confidence: "high",
                  rationale: "The code path can return before the write rejects.",
                  evidence: "The missing await is on the changed path.",
                  suggestedSeverity: "P1",
                },
              };
            case "synthesize-review":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Review\n\n- P1 Missing await drops write failures.",
                structuredOutput: {
                  verifiedIssueCount: 1,
                  verifiedIssueIds: ["correctness-missing-await"],
                  risk: "medium",
                  validationPlan: ["bun test src/service.test.ts"],
                  discardedIssueCount: 0,
                },
              };
            default:
              throw new Error(`Unexpected deep-review step: ${spec.id}`);
          }
        },
      },
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_workflow");
    const run = await runStore.getRun("wfr_deep_review_workflow");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-review-surface",
      "review-correctness",
      "review-tests",
      "review-security-reliability",
      "review-architecture",
      "triage-candidate-issues",
      "verify-issue-0",
      "synthesize-review",
    ]);
    expect(taskCalls.map((call) => call.agentId)).toEqual([
      "explore",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
      "exec",
    ]);
    expect(
      taskCalls
        .filter((call) => call.agentId === "exec")
        .every((call) => call.prompt.includes("read-only deep code review task"))
    ).toBe(true);
    expect(taskCalls.every((call) => call.outputSchema != null)).toBe(true);
    expect(run.events.filter((event) => event.type === "phase").map((event) => event.name)).toEqual(
      ["scope", "lane-review", "triage-dedupe", "adversarial-verification", "final-synthesis"]
    );
    expect(result).toEqual({
      reportMarkdown: "# Deep Review\n\n- P1 Missing await drops write failures.",
      structuredOutput: {
        target: "PR #123",
        scope: {
          summary: "PR touches persistence service code.",
          files: ["src/service.ts"],
          riskAreas: ["async persistence"],
          lanes: ["correctness", "tests", "security-reliability"],
        },
        laneIssues: [issue],
        triagedIssues: [issue],
        verification: [
          {
            issueId: "correctness-missing-await",
            verdict: "valid",
            confidence: "high",
            rationale: "The code path can return before the write rejects.",
            evidence: "The missing await is on the changed path.",
            suggestedSeverity: "P1",
          },
        ],
        final: {
          verifiedIssueCount: 1,
          verifiedIssueIds: ["correctness-missing-await"],
          risk: "medium",
          validationPlan: ["bun test src/service.test.ts"],
          discardedIssueCount: 0,
        },
      },
    });
  }, 10_000);

  test("captures parent Git action context before spawning review agents", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-git-context");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    const overrideMarkerPath = path.join(tmp.path, "override-ran.txt");
    await fs.mkdir(path.join(projectRoot, "git"), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, "git", "status.js"),
      `module.exports.metadata = { version: 1, description: "Override status", effect: "workspace" };
      module.exports.execute = async function () {
        require("node:fs").writeFileSync(${JSON.stringify(overrideMarkerPath)}, "ran");
        return { branch: "override", staged: [], unstaged: [], untracked: [], ignored: [] };
      };`,
      "utf-8"
    );
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "base\n", "utf-8");
    await runGit(repoRoot, ["add", "tracked.txt"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "base\ndirty\n", "utf-8");

    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_git_context",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { input: "current workspace changes", maxCandidates: 1 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-review-surface":
              return {
                taskId: "task_scope",
                reportMarkdown: "Review dirty tracked file.",
                structuredOutput: {
                  summary: "Parent workspace has a dirty tracked file.",
                  files: ["tracked.txt"],
                  riskAreas: ["dirty working tree"],
                  lanes: ["correctness"],
                },
              };
            case "review-correctness":
            case "review-tests":
            case "review-architecture":
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: "No findings.",
                structuredOutput: { issues: [] },
              };
            case "triage-candidate-issues":
              return {
                taskId: "task_triage",
                reportMarkdown: "No candidates.",
                structuredOutput: { issues: [] },
              };
            case "synthesize-review":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Review\n\nNo verified issues.",
                structuredOutput: {
                  verifiedIssueCount: 0,
                  verifiedIssueIds: [],
                  risk: "low",
                  validationPlan: ["Inspect captured Git snapshot"],
                  discardedIssueCount: 0,
                },
              };
            default:
              throw new Error(`Unexpected deep-review git context step: ${spec.id}`);
          }
        },
      },
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await runner.run("wfr_deep_review_git_context");

    const scopePrompt = taskCalls.find((call) => call.id === "scope-review-surface")?.prompt;
    const lanePrompt = taskCalls.find((call) => call.id === "review-correctness")?.prompt;
    expect(scopePrompt).toContain("Git snapshot");
    expect(scopePrompt).toContain("tracked.txt");
    expect(scopePrompt).toContain("Diff snapshot");
    expect(scopePrompt).toContain("+dirty");
    expect(lanePrompt).toContain("+dirty");
    let overrideRan = true;
    try {
      await fs.access(overrideMarkerPath);
    } catch {
      overrideRan = false;
    }
    expect(overrideRan).toBe(false);
    const run = await runStore.getRun("wfr_deep_review_git_context");
    expect(
      run.events.some(
        (event) =>
          event.type === "action" && event.name === "git.status" && event.status === "completed"
      )
    ).toBe(true);
    expect(
      run.events.some(
        (event) =>
          event.type === "action" && event.name === "git.diff" && event.status === "completed"
      )
    ).toBe(true);
  }, 10_000);

  test("does not mix automatic Git context into explicit review input", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-explicit-context");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "unrelated.txt"), "base\n", "utf-8");
    await runGit(repoRoot, ["add", "unrelated.txt"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);
    await fs.writeFile(path.join(repoRoot, "unrelated.txt"), "base\nunrelated dirty\n", "utf-8");

    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_explicit_context",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: {
        input: "explicit diff",
        files: ["explicit.txt"],
        diff: "diff --git a/explicit.txt b/explicit.txt\n+explicit change",
        maxCandidates: 1,
      },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: createNoIssueDeepReviewTaskAdapter(taskCalls),
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await runner.run("wfr_deep_review_explicit_context");

    const prompts = taskCalls.map((call) => call.prompt).join("\n---\n");
    expect(prompts).toContain("explicit.txt");
    expect(prompts).toContain("+explicit change");
    expect(prompts).not.toContain("Git snapshot");
    expect(prompts).not.toContain("unrelated.txt");
    expect(prompts).not.toContain("unrelated dirty");
    const explicitRun = await runStore.getRun("wfr_deep_review_explicit_context");
    expect(explicitRun.events.some((event) => event.type === "action")).toBe(false);
  }, 10_000);

  test("continues with diff context when status output is too large", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-status-fallback");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "base\n", "utf-8");
    await runGit(repoRoot, ["add", "tracked.txt"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "base\ndirty\n", "utf-8");
    for (let index = 0; index < 1300; index += 1) {
      await fs.writeFile(
        path.join(repoRoot, `untracked-${String(index).padStart(4, "0")}-${"x".repeat(48)}.txt`),
        "x",
        "utf-8"
      );
    }

    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_status_fallback",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { input: "current workspace changes", maxCandidates: 1 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: createNoIssueDeepReviewTaskAdapter(taskCalls),
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await runner.run("wfr_deep_review_status_fallback");

    const scopePrompt = taskCalls.find((call) => call.id === "scope-review-surface")?.prompt;
    expect(scopePrompt).toContain("Git context warnings");
    expect(scopePrompt).toContain("git.status");
    expect(scopePrompt).toContain("Diff snapshot");
    expect(scopePrompt).toContain("+dirty");
  }, 10_000);

  test("auto-fix applies selected verified findings and validates integrated changes", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);
    const { stdout: reviewedHeadStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
    });
    const reviewedHeadSha = reviewedHeadStdout.trim();

    const issue = {
      id: "await-write",
      severity: "P1",
      category: "correctness",
      title: "Missing await drops write failures",
      rationale: "The service reports success before persistence completes.",
      evidence: "src/service.ts calls persist() without awaiting it.",
      filePaths: ["src/service.ts"],
      suggestedFix: "Await persist() before returning success.",
      validation: "Add a failing persistence regression test.",
      confidence: "high",
    };
    const skippedIssue = {
      ...issue,
      id: "docs-only",
      severity: "P3",
      title: "Docs are unclear",
      confidence: "medium",
    };
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { input: "current workspace changes --fix", maxCandidates: 2, maxFixes: 1 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const applyCalls: unknown[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-review-surface":
              return {
                taskId: "task_scope",
                reportMarkdown: "Review service changes.",
                structuredOutput: {
                  summary: "PR touches persistence service code.",
                  files: ["src/service.ts"],
                  riskAreas: ["async persistence"],
                  lanes: ["correctness"],
                },
              };
            case "review-correctness":
            case "review-tests":
            case "review-architecture":
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: "Findings.",
                structuredOutput: {
                  issues: spec.id === "review-correctness" ? [issue, skippedIssue] : [],
                },
              };
            case "triage-candidate-issues":
              return {
                taskId: "task_triage",
                reportMarkdown: "Two candidates.",
                structuredOutput: { issues: [issue, skippedIssue] },
              };
            case "verify-issue-0":
              return {
                taskId: "task_verify_0",
                reportMarkdown: "Issue is valid.",
                structuredOutput: {
                  issueId: "await-write",
                  verdict: "valid",
                  confidence: "high",
                  rationale: "The code path can return early.",
                },
              };
            case "verify-issue-1":
              return {
                taskId: "task_verify_1",
                reportMarkdown: "Issue needs info.",
                structuredOutput: {
                  issueId: "docs-only",
                  verdict: "needs-info",
                  confidence: "medium",
                  rationale: "No concrete breakage.",
                },
              };
            case "synthesize-review":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Review\n\n- P1 Missing await drops write failures.",
                structuredOutput: {
                  verifiedIssueCount: 1,
                  verifiedIssueIds: ["await-write"],
                  risk: "medium",
                  validationPlan: ["bun test src/service.test.ts"],
                  discardedIssueCount: 1,
                },
              };
            case "fix-issue-0":
              expect(spec.prompt).toContain("Fix exactly one verified deep-review finding");
              expect(spec.prompt).toContain("await-write");
              return {
                taskId: "task_fix_0",
                reportMarkdown: "Fixed missing await.",
                structuredOutput: {
                  issueId: "await-write",
                  status: "fixed",
                  summary: "Awaited the write and added a regression test.",
                  validation: ["bun test src/service.test.ts"],
                  commitCreated: true,
                },
              };
            case "validate-auto-fixes":
              return {
                taskId: "task_validate",
                reportMarkdown: "Validation passed.",
                structuredOutput: {
                  status: "passed",
                  commands: ["bun test src/service.test.ts"],
                  summary: "Targeted tests passed.",
                  failures: [],
                },
              };
            default:
              throw new Error(`Unexpected deep-review fix step: ${spec.id}`);
          }
        },
        async applyPatch(spec) {
          applyCalls.push(spec);
          return {
            success: true,
            taskId: spec.sourceTaskId,
            projectResults: [{ projectPath: repoRoot, projectName: "repo", status: "applied" }],
          };
        },
      },
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix");
    const run = await runStore.getRun("wfr_deep_review_fix");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-review-surface",
      "review-correctness",
      "review-tests",
      "review-architecture",
      "triage-candidate-issues",
      "verify-issue-0",
      "verify-issue-1",
      "synthesize-review",
      "fix-issue-0",
      "validate-auto-fixes",
    ]);
    expect(taskCalls.find((call) => call.id === "validate-auto-fixes")?.agentId).toBe("explore");
    expect(applyCalls).toEqual([
      expect.objectContaining({
        id: "apply-fix-0",
        sourceTaskId: "task_fix_0",
        target: "parent",
        expectedHeadSha: reviewedHeadSha,
      }),
    ]);
    expect(run.events.filter((event) => event.type === "phase").map((event) => event.name)).toEqual(
      [
        "scope",
        "lane-review",
        "triage-dedupe",
        "adversarial-verification",
        "final-synthesis",
        "fix-preflight",
      ]
    );
    expect(result.reportMarkdown).toContain("## Auto-fix results");
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          requested: true,
          selectedIssues: [{ issueId: "await-write", severity: "P1" }],
          attempts: [{ issueId: "await-write", taskId: "task_fix_0", status: "fixed" }],
          applications: [{ issueId: "await-write", sourceTaskId: "task_fix_0", status: "applied" }],
          validation: { status: "passed" },
          unresolved: [],
        },
      },
    });
  }, 10_000);

  test("auto-fix uses final synthesis issue IDs and rejects mismatched fixer output", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-final-gate");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);

    const keptIssue = {
      id: "kept-by-final",
      severity: "P1",
      category: "correctness",
      title: "Final review keeps this issue",
      rationale: "The final synthesis includes this issue.",
      evidence: "service.ts has a kept issue.",
      filePaths: ["service.ts"],
      suggestedFix: "Fix only this issue.",
      validation: "Run targeted tests.",
      confidence: "high",
    };
    const droppedIssue = {
      ...keptIssue,
      id: "dropped-by-final",
      title: "Final review drops this issue",
      rationale: "The final synthesis omits this candidate.",
    };
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_final_gate",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { fix: true, input: "current workspace changes", maxCandidates: 2 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const applyCalls: unknown[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-review-surface":
              return {
                taskId: "task_scope",
                reportMarkdown: "Scoped.",
                structuredOutput: {
                  summary: "Review service code.",
                  files: ["service.ts"],
                  riskAreas: ["correctness"],
                  lanes: ["correctness"],
                },
              };
            case "review-correctness":
            case "review-tests":
            case "review-architecture":
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: "Findings.",
                structuredOutput: {
                  issues: spec.id === "review-correctness" ? [keptIssue, droppedIssue] : [],
                },
              };
            case "triage-candidate-issues":
              return {
                taskId: "task_triage",
                reportMarkdown: "Two candidates.",
                structuredOutput: { issues: [keptIssue, droppedIssue] },
              };
            case "verify-issue-0":
              return {
                taskId: "task_verify_0",
                reportMarkdown: "Kept issue is valid.",
                structuredOutput: {
                  issueId: "kept-by-final",
                  verdict: "valid",
                  confidence: "high",
                  rationale: "Valid and included by final synthesis.",
                },
              };
            case "verify-issue-1":
              return {
                taskId: "task_verify_1",
                reportMarkdown: "Dropped issue is valid but omitted.",
                structuredOutput: {
                  issueId: "dropped-by-final",
                  verdict: "valid",
                  confidence: "high",
                  rationale: "Valid but intentionally not included in the final review.",
                },
              };
            case "synthesize-review":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Review\n\nOne final finding.",
                structuredOutput: {
                  verifiedIssueCount: 1,
                  verifiedIssueIds: ["kept-by-final"],
                  risk: "medium",
                  validationPlan: [],
                  discardedIssueCount: 1,
                },
              };
            case "fix-issue-0":
              expect(spec.prompt).toContain("kept-by-final");
              expect(spec.prompt).not.toContain("dropped-by-final");
              return {
                taskId: "task_fix_0",
                reportMarkdown: "Returned the wrong issue id.",
                structuredOutput: {
                  issueId: "dropped-by-final",
                  status: "fixed",
                  summary: "This should not be applied to the kept issue.",
                  validation: [],
                  commitCreated: true,
                },
              };
            default:
              throw new Error(`Unexpected final-gated auto-fix step: ${spec.id}`);
          }
        },
        async applyPatch(spec) {
          applyCalls.push(spec);
          return { success: true, taskId: spec.sourceTaskId, projectResults: [] };
        },
      },
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_final_gate");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-review-surface",
      "review-correctness",
      "review-tests",
      "review-architecture",
      "triage-candidate-issues",
      "verify-issue-0",
      "verify-issue-1",
      "synthesize-review",
      "fix-issue-0",
    ]);
    expect(applyCalls).toEqual([]);
    expect(result.reportMarkdown).toContain(
      "fixer reported issueId dropped-by-final for kept-by-final"
    );
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          selectedIssues: [{ issueId: "kept-by-final" }],
          attempts: [{ issueId: "kept-by-final", status: "fixed" }],
          applications: [],
          unresolved: [
            {
              issueId: "kept-by-final",
              reason: "fixer reported issueId dropped-by-final for kept-by-final",
            },
          ],
        },
      },
    });
  }, 10_000);

  test("auto-fix skips candidates when verifier reports an empty issue ID", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-verifier-mismatch");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);

    const issue = {
      id: "await-write",
      severity: "P1",
      category: "correctness",
      title: "Missing await drops write failures",
      rationale: "The service reports success before persistence completes.",
      evidence: "service.ts calls persist() without awaiting it.",
      filePaths: ["service.ts"],
      suggestedFix: "Await persist() before returning success.",
      validation: "Add a failing persistence regression test.",
      confidence: "high",
    };
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_verifier_mismatch",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { fix: true, input: "current workspace changes", maxCandidates: 1 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-review-surface":
              return {
                taskId: "task_scope",
                reportMarkdown: "Scoped.",
                structuredOutput: {
                  summary: "Review service code.",
                  files: ["service.ts"],
                  riskAreas: ["correctness"],
                  lanes: ["correctness"],
                },
              };
            case "review-correctness":
            case "review-tests":
            case "review-architecture":
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: "Findings.",
                structuredOutput: { issues: spec.id === "review-correctness" ? [issue] : [] },
              };
            case "triage-candidate-issues":
              return {
                taskId: "task_triage",
                reportMarkdown: "One candidate.",
                structuredOutput: { issues: [issue] },
              };
            case "verify-issue-0":
              return {
                taskId: "task_verify_0",
                reportMarkdown: "Empty issue id.",
                structuredOutput: {
                  issueId: "",
                  verdict: "valid",
                  confidence: "high",
                  rationale: "This should not authorize await-write.",
                },
              };
            case "synthesize-review":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Review\n\nOne final finding.",
                structuredOutput: {
                  verifiedIssueCount: 1,
                  verifiedIssueIds: ["await-write"],
                  risk: "medium",
                  validationPlan: [],
                  discardedIssueCount: 0,
                },
              };
            default:
              throw new Error(`Unexpected verifier-mismatch auto-fix step: ${spec.id}`);
          }
        },
      },
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_verifier_mismatch");

    expect(taskCalls.map((call) => call.id)).not.toContain("fix-issue-0");
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          requested: true,
          selectedIssues: [],
          attempts: [],
          applications: [],
          unresolved: [],
        },
      },
    });
  }, 10_000);

  test("auto-fix honors fixIssueIds and does not apply patches for non-fixed attempts", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-filter");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);

    const issueA = {
      id: "skip-me",
      severity: "P1",
      category: "correctness",
      title: "Skipped by filter",
      rationale: "This finding is valid but not requested.",
      evidence: "service.ts has a skipped issue.",
      filePaths: ["service.ts"],
      suggestedFix: "Do not select this issue.",
      validation: "No validation.",
      confidence: "high",
    };
    const issueB = {
      ...issueA,
      id: "needs-more-info",
      title: "Selected but cannot be fixed automatically",
      suggestedFix: "Needs product clarification.",
    };
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_filter",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: {
        fix: true,
        input: "current workspace changes",
        maxCandidates: 2,
        fixIssueIds: ["needs-more-info"],
      },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const applyCalls: unknown[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-review-surface":
              return {
                taskId: "task_scope",
                reportMarkdown: "Scoped.",
                structuredOutput: {
                  summary: "Review service code.",
                  files: ["service.ts"],
                  riskAreas: ["correctness"],
                  lanes: ["correctness"],
                },
              };
            case "review-correctness":
            case "review-tests":
            case "review-architecture":
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: "Findings.",
                structuredOutput: {
                  issues: spec.id === "review-correctness" ? [issueA, issueB] : [],
                },
              };
            case "triage-candidate-issues":
              return {
                taskId: "task_triage",
                reportMarkdown: "Two candidates.",
                structuredOutput: { issues: [issueA, issueB] },
              };
            case "verify-issue-0":
              return {
                taskId: "task_verify_0",
                reportMarkdown: "Valid but filtered.",
                structuredOutput: {
                  issueId: "skip-me",
                  verdict: "valid",
                  confidence: "high",
                  rationale: "Valid but not selected.",
                },
              };
            case "verify-issue-1":
              return {
                taskId: "task_verify_1",
                reportMarkdown: "Valid and selected.",
                structuredOutput: {
                  issueId: "needs-more-info",
                  verdict: "valid",
                  confidence: "medium",
                  rationale: "Valid but needs clarification.",
                },
              };
            case "synthesize-review":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Review\n\nTwo findings.",
                structuredOutput: {
                  verifiedIssueCount: 2,
                  verifiedIssueIds: ["needs-more-info", "skip-me"],
                  risk: "medium",
                  validationPlan: [],
                  discardedIssueCount: 0,
                },
              };
            case "fix-issue-0":
              expect(spec.prompt).toContain("needs-more-info");
              expect(spec.prompt).not.toContain("skip-me");
              return {
                taskId: "task_fix_0",
                reportMarkdown: "Needs info.",
                structuredOutput: {
                  issueId: "needs-more-info",
                  status: "needs-info",
                  summary: "Cannot fix safely without product direction.",
                  validation: [],
                  commitCreated: false,
                },
              };
            default:
              throw new Error(`Unexpected filtered auto-fix step: ${spec.id}`);
          }
        },
        async applyPatch(spec) {
          applyCalls.push(spec);
          return { success: true, taskId: spec.sourceTaskId, projectResults: [] };
        },
      },
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_filter");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-review-surface",
      "review-correctness",
      "review-tests",
      "review-architecture",
      "triage-candidate-issues",
      "verify-issue-0",
      "verify-issue-1",
      "synthesize-review",
      "fix-issue-0",
    ]);
    expect(applyCalls).toEqual([]);
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          selectedIssues: [{ issueId: "needs-more-info" }],
          attempts: [{ issueId: "needs-more-info", status: "needs-info" }],
          applications: [],
          unresolved: [{ issueId: "needs-more-info", reason: "needs-info" }],
        },
      },
    });
  }, 10_000);

  test("auto-fix skips dirty worktrees after completing the review", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-dirty");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 2;\n", "utf-8");

    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_dirty",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { input: "current workspace changes --fix", maxCandidates: 1 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: createNoIssueDeepReviewTaskAdapter(taskCalls),
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_dirty");

    expect(taskCalls.map((call) => call.id)).not.toContain("fix-issue-0");
    expect(result.reportMarkdown).toContain("auto-fix requires a clean committed local worktree");
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          requested: true,
          skippedReason: "auto-fix requires a clean committed local worktree",
          selectedIssues: [],
        },
      },
    });
  }, 10_000);

  test("auto-fix skips when explicit head ref is not the current branch", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-noncurrent-head");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);

    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_noncurrent_head",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: {
        fix: true,
        input: "current workspace changes",
        baseRef: "main",
        headRef: "feature-branch",
        maxCandidates: 1,
      },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: createNoIssueDeepReviewTaskAdapter(taskCalls),
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_noncurrent_head");

    expect(taskCalls.map((call) => call.id)).not.toContain("fix-issue-0");
    expect(result.reportMarkdown).toContain(
      "auto-fix requires the reviewed head ref to be the current checked-out branch"
    );
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          requested: true,
          skippedReason:
            "auto-fix requires the reviewed head ref to be the current checked-out branch",
          selectedIssues: [],
        },
      },
    });
  }, 10_000);

  test("auto-fix skips when the checkout changes after review context is captured", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-checkout-drift");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);

    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_checkout_drift",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { fix: true, input: "current workspace changes", maxCandidates: 1 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          if (spec.id === "synthesize-review") {
            await runGit(repoRoot, ["checkout", "-b", "feature"]);
          }
          return createNoIssueDeepReviewTaskAdapter([]).runAgent(spec);
        },
      },
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_checkout_drift");

    expect(taskCalls.map((call) => call.id)).not.toContain("fix-issue-0");
    expect(result.reportMarkdown).toContain(
      "auto-fix requires the current Git branch to match the reviewed snapshot"
    );
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          requested: true,
          skippedReason: "auto-fix requires the current Git branch to match the reviewed snapshot",
          selectedIssues: [],
        },
      },
    });
  }, 10_000);

  test("auto-fix delegates conflict resolution and applies resolver patch", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-conflict");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);

    const issue = {
      id: "conflicting-fix",
      severity: "P2",
      category: "correctness",
      title: "Branch-specific stale result is reused",
      rationale: "The cache key omits the branch name.",
      evidence: "src/service.ts stores one result for all branches.",
      filePaths: ["src/service.ts"],
      suggestedFix: "Include the branch in the cache key.",
      validation: "Add a branch-specific regression test.",
      confidence: "high",
    };
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_conflict",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { fix: true, input: "current workspace changes", maxCandidates: 1 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const applyCallIds: string[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-review-surface":
              return {
                taskId: "task_scope",
                reportMarkdown: "Scoped.",
                structuredOutput: {
                  summary: "Review service cache code.",
                  files: ["src/service.ts"],
                  riskAreas: ["cache keying"],
                  lanes: ["correctness"],
                },
              };
            case "review-correctness":
            case "review-tests":
            case "review-architecture":
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: "Findings.",
                structuredOutput: { issues: spec.id === "review-correctness" ? [issue] : [] },
              };
            case "triage-candidate-issues":
              return {
                taskId: "task_triage",
                reportMarkdown: "One candidate.",
                structuredOutput: { issues: [issue] },
              };
            case "verify-issue-0":
              return {
                taskId: "task_verify_0",
                reportMarkdown: "Issue is valid.",
                structuredOutput: {
                  issueId: "conflicting-fix",
                  verdict: "valid",
                  confidence: "medium",
                  rationale: "The stale cache is reachable.",
                },
              };
            case "synthesize-review":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Review\n\n- P2 Cache key omits branch.",
                structuredOutput: {
                  verifiedIssueCount: 1,
                  verifiedIssueIds: ["conflicting-fix"],
                  risk: "medium",
                  validationPlan: ["bun test src/service.test.ts"],
                  discardedIssueCount: 0,
                },
              };
            case "fix-issue-0":
              return {
                taskId: "task_fix_0",
                reportMarkdown: "Fixed cache key.",
                structuredOutput: {
                  issueId: "conflicting-fix",
                  status: "fixed",
                  summary: "Included branch in cache key.",
                  validation: ["bun test src/service.test.ts"],
                  commitCreated: true,
                },
              };
            case "resolve-fix-0-conflict":
              expect(spec.prompt).toContain("Failing fixer task ID: task_fix_0");
              expect(spec.prompt).toContain("conflict.ts");
              return {
                taskId: "task_resolve_0",
                reportMarkdown: "Resolved conflict.",
                structuredOutput: {
                  issueId: "conflicting-fix",
                  status: "resolved",
                  summary: "Resolved overlapping cache edits.",
                  validation: ["bun test src/service.test.ts"],
                  commitCreated: true,
                },
              };
            case "validate-auto-fixes":
              return {
                taskId: "task_validate",
                reportMarkdown: "Validation passed.",
                structuredOutput: {
                  status: "passed",
                  commands: ["bun test src/service.test.ts"],
                  summary: "Targeted tests passed.",
                  failures: [],
                },
              };
            default:
              throw new Error(`Unexpected deep-review conflict step: ${spec.id}`);
          }
        },
        async applyPatch(spec) {
          applyCallIds.push(spec.id);
          if (spec.id === "apply-fix-0") {
            return {
              success: false,
              taskId: spec.sourceTaskId,
              error: "Patch conflict",
              conflictPaths: ["conflict.ts"],
              projectResults: [
                {
                  projectPath: repoRoot,
                  projectName: "repo",
                  status: "failed",
                  failedPatchSubject: "fix cache key",
                  conflictPaths: ["conflict.ts"],
                },
              ],
            };
          }
          return {
            success: true,
            taskId: spec.sourceTaskId,
            projectResults: [{ projectPath: repoRoot, projectName: "repo", status: "applied" }],
          };
        },
      },
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_conflict");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-review-surface",
      "review-correctness",
      "review-tests",
      "review-architecture",
      "triage-candidate-issues",
      "verify-issue-0",
      "synthesize-review",
      "fix-issue-0",
      "resolve-fix-0-conflict",
      "validate-auto-fixes",
    ]);
    expect(applyCallIds).toEqual(["apply-fix-0", "apply-resolved-fix-0"]);
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          applications: [
            { issueId: "conflicting-fix", status: "conflict", conflictPaths: ["conflict.ts"] },
            { issueId: "conflicting-fix", status: "applied", sourceTaskId: "task_resolve_0" },
          ],
          resolutions: [
            {
              issueId: "conflicting-fix",
              resolverTaskId: "task_resolve_0",
              status: "resolved",
              applyStatus: "applied",
            },
          ],
          validation: { status: "passed" },
          unresolved: [],
        },
      },
    });
  }, 10_000);

  test("auto-fix rejects mismatched resolver output and reports conflict details", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-resolver-mismatch");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "service.ts"), "export const value = 1;\n", "utf-8");
    await runGit(repoRoot, ["add", "service.ts"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);

    const issue = {
      id: "conflicting-fix",
      severity: "P2",
      category: "correctness",
      title: "Branch-specific stale result is reused",
      rationale: "The cache key omits the branch name.",
      evidence: "src/service.ts stores one result for all branches.",
      filePaths: ["src/service.ts"],
      suggestedFix: "Include the branch in the cache key.",
      validation: "Add a branch-specific regression test.",
      confidence: "high",
    };
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_resolver_mismatch",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { fix: true, input: "current workspace changes", maxCandidates: 1 },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });

    const taskCalls: WorkflowAgentSpec[] = [];
    const applyCallIds: string[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: {
        async runAgent(spec) {
          taskCalls.push(spec);
          switch (spec.id) {
            case "scope-review-surface":
              return {
                taskId: "task_scope",
                reportMarkdown: "Scoped.",
                structuredOutput: {
                  summary: "Review service cache code.",
                  files: ["src/service.ts"],
                  riskAreas: ["cache keying"],
                  lanes: ["correctness"],
                },
              };
            case "review-correctness":
            case "review-tests":
            case "review-architecture":
              return {
                taskId: `task_${spec.id}`,
                reportMarkdown: "Findings.",
                structuredOutput: { issues: spec.id === "review-correctness" ? [issue] : [] },
              };
            case "triage-candidate-issues":
              return {
                taskId: "task_triage",
                reportMarkdown: "One candidate.",
                structuredOutput: { issues: [issue] },
              };
            case "verify-issue-0":
              return {
                taskId: "task_verify_0",
                reportMarkdown: "Issue is valid.",
                structuredOutput: {
                  issueId: "conflicting-fix",
                  verdict: "valid",
                  confidence: "medium",
                  rationale: "The stale cache is reachable.",
                },
              };
            case "synthesize-review":
              return {
                taskId: "task_final",
                reportMarkdown: "# Deep Review\n\n- P2 Cache key omits branch.",
                structuredOutput: {
                  verifiedIssueCount: 1,
                  verifiedIssueIds: ["conflicting-fix"],
                  risk: "medium",
                  validationPlan: ["bun test src/service.test.ts"],
                  discardedIssueCount: 0,
                },
              };
            case "fix-issue-0":
              return {
                taskId: "task_fix_0",
                reportMarkdown: "Fixed cache key.",
                structuredOutput: {
                  issueId: "conflicting-fix",
                  status: "fixed",
                  summary: "Included branch in cache key.",
                  validation: ["bun test src/service.test.ts"],
                  commitCreated: true,
                },
              };
            case "resolve-fix-0-conflict":
              return {
                taskId: "task_resolve_0",
                reportMarkdown: "Resolved the wrong issue.",
                structuredOutput: {
                  issueId: "other-issue",
                  status: "resolved",
                  summary: "This should not be attributed to conflicting-fix.",
                  validation: [],
                  commitCreated: true,
                },
              };
            default:
              throw new Error(`Unexpected resolver-mismatch step: ${spec.id}`);
          }
        },
        async applyPatch(spec) {
          applyCallIds.push(spec.id);
          return {
            success: false,
            taskId: spec.sourceTaskId,
            error: "Patch conflict",
            conflictPaths: ["conflict.ts"],
            failedPatchSubject: "fix cache key",
            projectResults: [
              {
                projectPath: repoRoot,
                projectName: "repo",
                status: "failed",
                failedPatchSubject: "fix cache key",
                conflictPaths: ["conflict.ts"],
              },
            ],
          };
        },
      },
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_resolver_mismatch");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-review-surface",
      "review-correctness",
      "review-tests",
      "review-architecture",
      "triage-candidate-issues",
      "verify-issue-0",
      "synthesize-review",
      "fix-issue-0",
      "resolve-fix-0-conflict",
    ]);
    expect(applyCallIds).toEqual(["apply-fix-0"]);
    expect(result.reportMarkdown).toContain("- Conflicts resolved: 0");
    expect(result.reportMarkdown).toContain("conflict.ts");
    expect(result.reportMarkdown).toContain(
      "resolver reported issueId other-issue for conflicting-fix"
    );
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          applications: [
            {
              issueId: "conflicting-fix",
              status: "conflict",
              conflictPaths: ["conflict.ts"],
              failedPatchSubject: "fix cache key",
            },
          ],
          resolutions: [{ issueId: "conflicting-fix", status: "resolved" }],
          unresolved: [
            {
              issueId: "conflicting-fix",
              reason: "resolver reported issueId other-issue for conflicting-fix",
            },
          ],
        },
      },
    });
  }, 10_000);

  test("prose mentions of --fix remain review-only", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-prose-fix-mention");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_prose_fix_mention",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { input: "review the deep-review-workflow --fix implementation", maxCandidates: 1 },
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: createNoIssueDeepReviewTaskAdapter(taskCalls),
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_prose_fix_mention");
    const run = await runStore.getRun("wfr_deep_review_prose_fix_mention");

    expect(taskCalls.map((call) => call.id)).not.toContain("fix-issue-0");
    expect(run.events.filter((event) => event.type === "phase").map((event) => event.name)).toEqual(
      ["scope", "lane-review", "triage-dedupe", "adversarial-verification", "final-synthesis"]
    );
    const structuredOutput = result.structuredOutput;
    if (
      structuredOutput == null ||
      typeof structuredOutput !== "object" ||
      Array.isArray(structuredOutput)
    ) {
      throw new Error("Expected deep-review result to include an object structuredOutput");
    }
    const structuredRecord = structuredOutput as Record<string, unknown>;
    expect(structuredRecord.target).toBe("review the deep-review-workflow --fix implementation");
    expect(Object.hasOwn(structuredRecord, "fix")).toBe(false);
  }, 10_000);

  test("--no-fix preserves review-only behavior even when --fix is also present", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-no-fix-flag");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_no_fix_flag",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: { input: "PR #123 --fix --no-fix", files: ["src/service.ts"], maxCandidates: 1 },
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: createNoIssueDeepReviewTaskAdapter(taskCalls),
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_no_fix_flag");
    const run = await runStore.getRun("wfr_deep_review_no_fix_flag");

    expect(taskCalls.map((call) => call.id)).toEqual([
      "scope-review-surface",
      "review-correctness",
      "review-tests",
      "review-architecture",
      "triage-candidate-issues",
      "synthesize-review",
    ]);
    expect(run.events.filter((event) => event.type === "phase").map((event) => event.name)).toEqual(
      ["scope", "lane-review", "triage-dedupe", "adversarial-verification", "final-synthesis"]
    );
    expect(result).toEqual({
      reportMarkdown: "# Deep Review\n\nNo verified issues.",
      structuredOutput: {
        target: "PR #123",
        scope: {
          summary: "Review target is scoped.",
          files: [],
          riskAreas: [],
          lanes: ["correctness"],
        },
        laneIssues: [],
        triagedIssues: [],
        verification: [],
        final: {
          verifiedIssueCount: 0,
          verifiedIssueIds: [],
          risk: "low",
          validationPlan: [],
          discardedIssueCount: 0,
        },
      },
    });
  }, 10_000);

  test("auto-fix skips explicit diff targets and does not spawn fixers", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-fix-explicit-diff");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_fix_explicit_diff",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: {
        input: "explicit diff --fix",
        files: ["src/service.ts"],
        diff: "diff --git a/src/service.ts b/src/service.ts\n+change",
        maxCandidates: 1,
      },
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: createNoIssueDeepReviewTaskAdapter(taskCalls),
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    const result = await runner.run("wfr_deep_review_fix_explicit_diff");

    expect(taskCalls.map((call) => call.id)).not.toContain("fix-issue-0");
    expect(result.reportMarkdown).toContain(
      "auto-fix requires a local current workspace target, not an explicit diff"
    );
    expect(result).toMatchObject({
      structuredOutput: {
        fix: {
          requested: true,
          skippedReason: "auto-fix requires a local current workspace target, not an explicit diff",
          selectedIssues: [],
        },
      },
    });
  }, 10_000);

  test("warns when explicit refs cannot be resolved", async () => {
    if (!deepReviewWorkflow) {
      throw new Error("Expected built-in deep-review-workflow workflow");
    }
    using tmp = new DisposableTempDir("deep-review-workflow-invalid-ref");
    const repoRoot = path.join(tmp.path, "repo");
    const projectRoot = path.join(tmp.path, "project-actions");
    const globalRoot = path.join(tmp.path, "global-actions");
    await fs.mkdir(repoRoot, { recursive: true });
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.email", "mux@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Mux"]);
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "base\n", "utf-8");
    await runGit(repoRoot, ["add", "tracked.txt"]);
    await runGit(repoRoot, ["commit", "-m", "base commit"]);
    await runGit(repoRoot, ["branch", "-M", "main"]);

    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
    await runStore.createRun({
      id: "wfr_deep_review_invalid_ref",
      workspaceId: "workspace-1",
      definition: {
        name: deepReviewWorkflow.name,
        description: deepReviewWorkflow.description,
        scope: "built-in",
        executable: true,
      },
      definitionSource: deepReviewWorkflow.source,
      args: {
        input: "invalid ref review",
        baseRef: "missing-base",
        headRef: "HEAD",
        maxCandidates: 1,
      },
      defaultActionCwd: repoRoot,
      now: "2026-05-29T00:00:00.000Z",
    });
    const taskCalls: WorkflowAgentSpec[] = [];
    const runner = new WorkflowRunner({
      runStore,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: createNoIssueDeepReviewTaskAdapter(taskCalls),
      actionRegistry: new WorkflowActionRegistry({ projectRoot, globalRoot }),
      projectTrusted: true,
      defaultActionCwd: repoRoot,
      runnerId: "runner-a",
      clock: {
        nowIso: () => "2026-05-29T00:00:01.000Z",
        nowMs: () => 1_000,
      },
    });

    await runner.run("wfr_deep_review_invalid_ref");

    const scopePrompt = taskCalls.find((call) => call.id === "scope-review-surface")?.prompt;
    expect(scopePrompt).toContain("Base ref: missing-base");
    expect(scopePrompt).toContain("WARNING: Requested base/head refs could not be resolved");
  }, 10_000);
});
