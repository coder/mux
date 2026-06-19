import { describe, expect, test } from "bun:test";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { BUILT_IN_WORKFLOW_DEFINITIONS } from "./builtInWorkflowDefinitions";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowRunner, type WorkflowAgentResult, type WorkflowAgentSpec } from "./WorkflowRunner";

const WORKFLOW_TEST_STALE_LEASE_MS = 100;

async function runBuiltInWorkflowFixture(options: {
  name: string;
  runId: string;
  args: unknown;
  taskCalls: WorkflowAgentSpec[];
  runAgent: (spec: WorkflowAgentSpec) => Promise<WorkflowAgentResult> | WorkflowAgentResult;
  applyPatch?: (spec: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;
}) {
  const definition = BUILT_IN_WORKFLOW_DEFINITIONS.find((item) => item.name === options.name);
  if (!definition) throw new Error(`Expected built-in workflow ${options.name}`);

  using tmp = new DisposableTempDir(options.runId);
  const runStore = new WorkflowRunStore({
    sessionDir: tmp.path,
    staleLeaseMs: WORKFLOW_TEST_STALE_LEASE_MS,
  });
  await runStore.createRun({
    id: options.runId,
    workspaceId: "workspace-1",
    definition: {
      name: definition.name,
      description: definition.description,
      scope: "built-in",
      executable: true,
    },
    definitionSource: definition.source,
    args: options.args,
    now: "2026-06-19T00:00:00.000Z",
  });

  const runner = new WorkflowRunner({
    runStore,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: {
      async runAgent(spec) {
        options.taskCalls.push(spec);
        return await options.runAgent(spec);
      },
      async applyPatch(spec) {
        if (!options.applyPatch) throw new Error("Unexpected applyPatch call");
        return await options.applyPatch(spec);
      },
    },
    runnerId: "runner-a",
    clock: {
      nowIso: () => "2026-06-19T00:00:01.000Z",
      nowMs: () => 1_000,
    },
  });

  const result = await runner.run(options.runId);
  const run = await runStore.getRun(options.runId);
  return { result, run };
}

describe("actionless built-in workflows", () => {
  test("deep-review delegates Git/review work to structured sub-agents", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const { result, run } = await runBuiltInWorkflowFixture({
      name: "deep-review-workflow",
      runId: "wfr_deep_review_actionless",
      args: { target: "current diff", maxCandidates: 2 },
      taskCalls,
      runAgent(spec) {
        switch (spec.id) {
          case "git-review-context":
            return {
              taskId: "task_git_context",
              reportMarkdown: "Collected Git review context.",
              structuredOutput: {
                baseRef: "main",
                headRef: "HEAD",
                status: {
                  branch: "feature",
                  upstream: "origin/feature",
                  headSha: "abc123",
                  ahead: 1,
                  behind: 0,
                  staged: [],
                  unstaged: [],
                  untracked: [],
                  clean: true,
                },
                changedFiles: { branch: ["file.ts"], staged: [], unstaged: [], untracked: [] },
                diffStat: "file.ts | 1 +",
                diff: "diff --git a/file.ts b/file.ts",
                commits: ["abc123 test"],
                failures: [],
                limitations: [],
                hasReviewableChanges: true,
              },
            };
          case "scope-review-surface":
            return {
              taskId: "task_scope",
              reportMarkdown: "Scoped review surface.",
              structuredOutput: {
                summary: "One TypeScript file changed.",
                intent: "Exercise actionless review flow.",
                files: ["file.ts"],
                risks: ["regression"],
                lanes: ["correctness"],
              },
            };
          case "review-correctness":
            return {
              taskId: "task_review",
              reportMarkdown: "No correctness issues.",
              structuredOutput: { issues: [] },
            };
          default:
            throw new Error(`Unexpected deep-review step: ${spec.id}`);
        }
      },
    });

    expect(run.status).toBe("completed");
    expect(taskCalls.map((call) => call.id)).toEqual([
      "git-review-context",
      "scope-review-surface",
      "review-correctness",
    ]);
    expect(taskCalls.every((call) => call.outputSchema != null)).toBe(true);
    expect(result).toMatchObject({
      structuredOutput: {
        mode: "review-only",
        candidates: [],
        verifications: [],
      },
    });
  });

  test("security-scan delegates state, scan, persistence, and patching to sub-agents", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const applyPatchSpecs: unknown[] = [];
    const { result, run } = await runBuiltInWorkflowFixture({
      name: "security-scan",
      runId: "wfr_security_scan_actionless",
      args: { target: "current workspace", verify: true },
      taskCalls,
      runAgent(spec) {
        switch (spec.id) {
          case "security-load-state-and-git-context":
            return {
              taskId: "task_state",
              reportMarkdown: "Loaded security state.",
              structuredOutput: {
                schemaVersion: 1,
                securityRoot: ".mux/security",
                gitContext: {
                  branch: "feature",
                  headSha: "abc123",
                  changedFiles: ["src/app.ts"],
                  diffStat: "src/app.ts | 1 +",
                  commits: ["abc123 test"],
                },
                cachedFindings: [],
                overrides: [],
                threatModelIndex: [],
                diagnostics: [],
              },
            };
          case "scope-security-surface":
            return {
              taskId: "task_scope",
              reportMarkdown: "Scoped security surface.",
              structuredOutput: {
                summary: "Small app surface.",
                appType: "desktop",
                entrypoints: ["src/app.ts"],
                trustBoundaries: ["renderer to main"],
                assets: ["workspace files"],
                privilegedOperations: ["filesystem"],
                files: [],
                lanes: ["secrets"],
              },
            };
          case "security-hash-scope-files":
            return {
              taskId: "task_hash",
              reportMarkdown: "No files to hash.",
              structuredOutput: { schemaVersion: 1, files: [], diagnostics: [] },
            };
          case "draft-threat-model":
            return {
              taskId: "task_threat_model",
              reportMarkdown: "Drafted threat model.",
              structuredOutput: {
                markdown: "# Security Threat Model\n",
                index: { sections: ["summary"], diagnostics: [] },
              },
            };
          case "discover-secrets":
            return {
              taskId: "task_discover",
              reportMarkdown: "No secret findings.",
              structuredOutput: { findings: [] },
            };
          case "security-match-findings":
            return {
              taskId: "task_match",
              reportMarkdown: "No findings to match.",
              structuredOutput: { decisions: [], aliasUpdates: [], diagnostics: [] },
            };
          case "grill-security-scope":
            return {
              taskId: "task_grill",
              reportMarkdown: "No extra gaps.",
              structuredOutput: { gaps: [], followUps: [], concerns: [] },
            };
          case "triage-security-findings":
            return {
              taskId: "task_triage",
              reportMarkdown: "No findings after triage.",
              structuredOutput: { findings: [] },
            };
          case "synthesize-security-scan":
            return {
              taskId: "task_final",
              reportMarkdown: "# Security Scan\n\nNo findings.",
              structuredOutput: {
                summary: "No findings.",
                findings: [],
                coverageGaps: [],
                validationPlan: [],
              },
            };
          case "security-write-state":
            return {
              taskId: "task_persist",
              reportMarkdown: "Persisted security state.",
              structuredOutput: {
                wroteFiles: true,
                paths: [".mux/security/runs/latest"],
                diagnostics: [],
              },
            };
          default:
            throw new Error(`Unexpected security-scan step: ${spec.id}`);
        }
      },
      applyPatch(spec) {
        applyPatchSpecs.push(spec);
        return { success: true, status: "applied", taskId: "task_persist" };
      },
    });

    expect(run.status).toBe("completed");
    expect(taskCalls.map((call) => call.id)).toEqual([
      "security-load-state-and-git-context",
      "scope-security-surface",
      "security-hash-scope-files",
      "draft-threat-model",
      "discover-secrets",
      "security-match-findings",
      "grill-security-scope",
      "triage-security-findings",
      "synthesize-security-scan",
      "security-write-state",
    ]);
    expect(taskCalls.every((call) => call.outputSchema != null)).toBe(true);
    expect(applyPatchSpecs).toHaveLength(1);
    expect(result).toMatchObject({
      structuredOutput: {
        candidates: [],
        persistenceApply: { success: true, status: "applied" },
      },
    });
  });
});
