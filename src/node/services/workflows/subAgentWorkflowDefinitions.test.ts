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
    expect(taskCalls.find((call) => call.id === "git-review-context")?.isolation).toBe("none");
    expect(taskCalls.every((call) => call.outputSchema != null)).toBe(true);
    expect(result).toMatchObject({
      structuredOutput: {
        mode: "review-only",
        candidates: [],
        verifications: [],
      },
    });
  });

  test("deep-review skips auto-fix when preflight current HEAD disagrees with reviewed HEAD", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const applyPatchSpecs: unknown[] = [];
    const issue = {
      id: "DR-1",
      title: "Missing validation",
      severity: "P2",
      category: "correctness",
      filePaths: ["file.ts"],
      evidence: "file.ts accepts unchecked input.",
      recommendation: "Validate input before use.",
      confidence: "high",
    };
    const { result, run } = await runBuiltInWorkflowFixture({
      name: "deep-review-workflow",
      runId: "wfr_deep_review_head_fence",
      args: { target: "current diff", fix: true, maxCandidates: 2 },
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
                  headSha: "reviewed123",
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
                commits: ["reviewed123 test"],
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
                intent: "Exercise reviewed HEAD fence.",
                files: ["file.ts"],
                risks: ["regression"],
                lanes: ["correctness"],
              },
            };
          case "review-correctness":
          case "triage-candidate-issues":
            return {
              taskId: "task_" + spec.id,
              reportMarkdown: "Found one issue.",
              structuredOutput: { issues: [issue] },
            };
          case "verify-issue-0":
            return {
              taskId: "task_verify",
              reportMarkdown: "Confirmed issue.",
              structuredOutput: {
                issueId: "DR-1",
                verdict: "confirmed",
                confidence: "high",
                evidence: "The unchecked input path is reachable.",
                notes: "Confirmed.",
              },
            };
          case "synthesize-review":
            return {
              taskId: "task_synthesize",
              reportMarkdown: "# Deep Review\n\nOne fixable issue.",
              structuredOutput: {
                summary: "One fixable issue.",
                issues: [
                  {
                    id: "DR-1",
                    title: "Missing validation",
                    severity: "P2",
                    verdict: "confirmed",
                    filePaths: ["file.ts"],
                    evidence: "The unchecked input path is reachable.",
                    recommendation: "Validate input before use.",
                  },
                ],
                questions: [],
                fixCandidateIds: ["DR-1"],
              },
            };
          case "git-preflight":
            return {
              taskId: "task_preflight",
              reportMarkdown: "Preflight reported a moved HEAD.",
              structuredOutput: {
                ok: true,
                reason: "",
                branch: "feature",
                headSha: "current999",
                expectedHeadSha: "reviewed123",
                clean: true,
                staged: [],
                unstaged: [],
                untracked: [],
              },
            };
          case "fix-review-findings":
            return {
              taskId: "task_fix",
              reportMarkdown: "Fixed issue in child workspace.",
              structuredOutput: {
                madeChanges: true,
                fixedIssueIds: ["DR-1"],
                skippedIssues: [],
                validation: [],
              },
            };
          default:
            throw new Error(`Unexpected deep-review step: ${spec.id}`);
        }
      },
      applyPatch(spec) {
        applyPatchSpecs.push(spec);
        return { success: true, status: "applied", taskId: "task_fix" };
      },
    });

    expect(run.status).toBe("completed");
    expect(taskCalls.map((call) => call.id)).not.toContain("fix-review-findings");
    expect(applyPatchSpecs).toHaveLength(0);
    expect(result).toMatchObject({
      structuredOutput: {
        mode: "fix-skipped",
        fix: {
          preflight: { headSha: "current999", expectedHeadSha: "reviewed123" },
        },
      },
    });
  });

  test("security-scan bundles persistence into the reviewed fix patch", async () => {
    const taskCalls: WorkflowAgentSpec[] = [];
    const applyPatchSpecs: unknown[] = [];
    const finding = {
      id: "SEC-1",
      ruleId: "test.missing-validation",
      title: "Missing validation",
      severity: "high",
      cwe: ["CWE-20"],
      owasp: ["A03"],
      locations: ["src/app.ts:1"],
      sourceSink: "input to privileged operation",
      proofHypothesis: "Unchecked input reaches a privileged operation.",
      recommendation: "Validate the input before use.",
      fingerprints: {
        primary: "primary",
        semanticAst: "semantic",
        matchBased: "match",
        scopeOffset: "offset",
        contextWindow: "context",
      },
    };
    const { result, run } = await runBuiltInWorkflowFixture({
      name: "security-scan",
      runId: "wfr_security_scan_actionless",
      args: { target: "current workspace", verify: true, fix: true },
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
          case "triage-security-findings":
            return {
              taskId: "task_" + spec.id,
              reportMarkdown: "Found one security finding.",
              structuredOutput: { findings: [finding] },
            };
          case "security-match-findings":
            return {
              taskId: "task_match",
              reportMarkdown: "Matched one new finding.",
              structuredOutput: {
                decisions: [
                  {
                    index: 0,
                    candidateId: "SEC-1",
                    match: "new",
                    findingId: "SEC-1",
                    reason: "New finding.",
                    shouldVerify: true,
                  },
                ],
                aliasUpdates: [],
                diagnostics: [],
              },
            };
          case "grill-security-scope":
            return {
              taskId: "task_grill",
              reportMarkdown: "No extra gaps.",
              structuredOutput: { gaps: [], followUps: [], concerns: [] },
            };
          case "verify-security-finding-0":
            return {
              taskId: "task_verify",
              reportMarkdown: "Verified finding.",
              structuredOutput: {
                findingId: "SEC-1",
                proofState: "verified",
                confidence: "high",
                evidence: "The unchecked input path is reachable.",
                safeToFix: true,
                recommendedValidation: ["bun test"],
              },
            };
          case "synthesize-security-scan":
            return {
              taskId: "task_final",
              reportMarkdown: "# Security Scan\n\nOne finding.",
              structuredOutput: {
                summary: "One finding.",
                findings: [
                  {
                    id: "SEC-1",
                    title: "Missing validation",
                    severity: "high",
                    proofState: "verified",
                    recommendation: "Validate the input before use.",
                  },
                ],
                coverageGaps: [],
                validationPlan: ["bun test"],
              },
            };
          case "security-fix-git-status":
            return {
              taskId: "task_preflight",
              reportMarkdown: "Fix preflight passed.",
              structuredOutput: {
                ok: true,
                reason: "",
                branch: "feature",
                headSha: "abc123",
                expectedHeadSha: "abc123",
                clean: true,
                staged: [],
                unstaged: [],
                untracked: [],
              },
            };
          case "fix-security-findings":
            return {
              taskId: "task_fix",
              reportMarkdown: "Fixed selected finding.",
              structuredOutput: {
                madeChanges: true,
                fixedFindingIds: ["SEC-1"],
                skippedFindings: [],
                validation: [],
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
        if ((spec as { id?: string }).id === "apply-security-fixes") {
          return {
            success: true,
            status: "applied",
            taskId: "task_fix",
            headCommitSha: "fixed456",
          };
        }
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
      "verify-security-finding-0",
      "synthesize-security-scan",
      "security-fix-git-status",
      "fix-security-findings",
    ]);
    expect(
      taskCalls.find((call) => call.id === "security-load-state-and-git-context")?.isolation
    ).toBe("none");
    expect(taskCalls.find((call) => call.id === "security-hash-scope-files")?.isolation).toBe(
      "none"
    );
    expect(taskCalls.every((call) => call.outputSchema != null)).toBe(true);
    expect(applyPatchSpecs).toHaveLength(1);
    expect(applyPatchSpecs[0]).toMatchObject({
      id: "apply-security-fixes",
      expectedHeadSha: "abc123",
    });
    expect(result).toMatchObject({
      structuredOutput: {
        candidates: [finding],
        fix: { applied: { headCommitSha: "fixed456" } },
        persistenceApply: { success: true, status: "applied" },
      },
    });
  });
});
