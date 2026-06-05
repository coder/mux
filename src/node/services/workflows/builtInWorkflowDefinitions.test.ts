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

describe("built-in deep-research workflow", () => {
  test("coordinates staged research, verification, and final structured synthesis", async () => {
    if (!deepResearch) {
      throw new Error("Expected built-in deep-research workflow");
    }
    using tmp = new DisposableTempDir("deep-research-workflow");
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
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
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
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
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
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
    const runStore = new WorkflowRunStore({ sessionDir: tmp.path, staleLeaseMs: 10 });
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
});
