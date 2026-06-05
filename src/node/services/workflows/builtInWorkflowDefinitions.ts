import type { WorkflowName } from "@/common/types/workflow";

export interface BuiltInWorkflowDefinition {
  name: WorkflowName;
  description: string;
  source: string;
}

export const BUILT_IN_WORKFLOW_DEFINITIONS: readonly BuiltInWorkflowDefinition[] = [
  {
    name: "deep-research",
    description: "Coordinate delegated agents to research, verify, and synthesize a topic.",
    source: `export default function deepResearch({ args, phase, log, agent, parallelAgents }) {
  const maxFanOut = 16;
  const exploreAgentId = "explore";
  const reasoningAgentId = "exec";
  // Some users configure Explore with fast/cheap models; reserve Exec for reasoning-heavy synthesis.
  const readOnlyReasoningPrompt =
    "This is a read-only deep-research reasoning task. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect evidence only as needed and report findings.\\n\\n";
  const topic = normalizeDeepResearchTopic(args);

  phase("scope", { topic });
  const scope = agent({
    id: "scope-topic",
    title: "Scope research topic",
    agentId: exploreAgentId,
    prompt:
      "Refine this deep research topic into a focused investigation. Return concise research questions and the refined topic.\\n\\nTopic: " +
      topic,
    outputSchema: {
      type: "object",
      required: ["refinedTopic", "questions"],
      additionalProperties: false,
      properties: {
        refinedTopic: { type: "string" },
        questions: { type: "array", items: { type: "string" } },
      },
    },
  });
  const refinedTopic = scope.structuredOutput.refinedTopic || topic;
  log("Scoped deep research topic", { refinedTopic });

  phase("source-discovery", { refinedTopic });
  const sources = agent({
    id: "discover-sources",
    title: "Discover high-signal sources",
    agentId: exploreAgentId,
    prompt:
      "Find high-signal primary or directly relevant sources for this research topic. Prefer repo files, specs, primary docs, and concrete evidence over summaries. Return sources with title, url/path, and relevance.\\n\\nTopic: " +
      refinedTopic +
      "\\nQuestions: " +
      scope.structuredOutput.questions.join("; "),
    outputSchema: {
      type: "object",
      required: ["sources"],
      additionalProperties: false,
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "url", "relevance"],
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              relevance: { type: "string" },
            },
          },
        },
      },
    },
  });
  const discoveredSources = sources.structuredOutput.sources.slice(0, maxFanOut);
  log("Discovered sources", { count: sources.structuredOutput.sources.length, selectedCount: discoveredSources.length });

  phase("source-synthesis", { sourceCount: discoveredSources.length });
  const sourceSummaries = discoveredSources.length > 0
    ? parallelAgents(
        discoveredSources.map(function (source, index) {
          return {
            id: "summarize-source-" + index,
            title: "Read and summarize source " + (index + 1),
            agentId: exploreAgentId,
            prompt:
              "Read or inspect this discovered source and summarize the evidence relevant to the research questions.\\n\\nTopic: " +
              refinedTopic +
              "\\nSource: " +
              JSON.stringify(source),
            outputSchema: {
              type: "object",
              required: ["source", "summary"],
              additionalProperties: false,
              properties: {
                source: { type: "string" },
                summary: { type: "string" },
              },
            },
          };
        })
      )
    : [];
  const summaries = { structuredOutput: { summaries: sourceSummaries.map(function (summary) { return summary.structuredOutput; }) } };

  phase("claim-extraction", { summaryCount: summaries.structuredOutput.summaries.length });
  const claims = agent({
    id: "extract-claims",
    title: "Extract claims and support",
    agentId: reasoningAgentId,
    prompt:
      readOnlyReasoningPrompt +
      "Extract the most important factual claims and supporting evidence from these source summaries. Return claims with support notes.\\n\\nTopic: " +
      refinedTopic +
      "\\nSummaries: " +
      JSON.stringify(summaries.structuredOutput.summaries),
    outputSchema: {
      type: "object",
      required: ["claims"],
      additionalProperties: false,
      properties: {
        claims: {
          type: "array",
          items: {
            type: "object",
            required: ["claim", "support"],
            additionalProperties: false,
            properties: {
              claim: { type: "string" },
              support: { type: "string" },
            },
          },
        },
      },
    },
  });

  const extractedClaims = claims.structuredOutput.claims.slice(0, maxFanOut);
  phase("adversarial-verification", { claimCount: extractedClaims.length });
  const verificationFindings = extractedClaims.length > 0
    ? parallelAgents(
        extractedClaims.map(function (claim, index) {
          return {
            id: "verify-claim-" + index,
            title: "Adversarially verify claim " + (index + 1),
            agentId: reasoningAgentId,
            prompt:
              readOnlyReasoningPrompt +
              "Challenge this claim. Look for contradictions, missing evidence, overreach, and lower-confidence areas. Return verdict and risk.\\n\\nTopic: " +
              refinedTopic +
              "\\nClaim: " +
              JSON.stringify(claim),
            outputSchema: {
              type: "object",
              required: ["claim", "verdict", "risk"],
              additionalProperties: false,
              properties: {
                claim: { type: "string" },
                verdict: { type: "string", enum: ["supported", "mixed", "refuted", "unclear"] },
                risk: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
          };
        })
      )
    : [];
  const verification = { structuredOutput: { findings: verificationFindings.map(function (finding) { return finding.structuredOutput; }) } };
  log("Verified claims", { count: verification.structuredOutput.findings.length });

  phase("final-synthesis", { topic: refinedTopic });
  const final = agent({
    id: "synthesize-report",
    title: "Synthesize final deep research report",
    agentId: reasoningAgentId,
    prompt:
      readOnlyReasoningPrompt +
      "Write the final deep research report. Include key findings, citations/source references by title or path, uncertainty, and recommendations for follow-up. Return confidence and remaining gaps as structured output.\\n\\nTopic: " +
      refinedTopic +
      "\\nSources: " +
      JSON.stringify(discoveredSources) +
      "\\nClaims: " +
      JSON.stringify(extractedClaims) +
      "\\nVerification: " +
      JSON.stringify(verification.structuredOutput.findings),
    outputSchema: {
      type: "object",
      required: ["confidence", "gaps"],
      additionalProperties: false,
      properties: {
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        gaps: { type: "array", items: { type: "string" } },
      },
    },
  });

  return {
    reportMarkdown: final.reportMarkdown,
    structuredOutput: {
      topic,
      refinedTopic,
      sources: discoveredSources,
      claims: extractedClaims,
      verification: verification.structuredOutput.findings,
      confidence: final.structuredOutput.confidence,
      gaps: final.structuredOutput.gaps,
    },
  };
}

function normalizeDeepResearchTopic(args) {
  if (typeof args === "string" && args.trim()) return args.trim();
  if (args && typeof args === "object") {
    if (typeof args.topic === "string" && args.topic.trim()) return args.topic.trim();
    if (typeof args.input === "string" && args.input.trim()) return args.input.trim();
    if (typeof args.query === "string" && args.query.trim()) return args.query.trim();
  }
  return JSON.stringify(args);
}
`,
  },
  // Keep the lightweight /deep-review skill; this workflow is the heavier structured path with
  // adversarial verification for review findings.
  {
    name: "deep-review-workflow",
    description:
      "Coordinate adversarial review agents to find, verify, and synthesize code review findings.",
    source: `export default function deepReviewWorkflow({ args, phase, log, agent, action, parallelAgents }) {
  const exploreAgentId = "explore";
  const reasoningAgentId = "exec";
  // Scope discovery stays on Explore; review judgment uses Exec for users with fast Explore defaults.
  const readOnlyReviewPrompt =
    "This is a read-only deep code review task. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report findings.\\n\\n";
  const input = normalizeDeepReviewArgs(args);
  const gitContext = collectGitReviewContext(action, input, log);
  applyGitContextToReviewInput(input, gitContext);
  const maxCandidates = input.maxCandidates;

  phase("scope", {
    target: input.target,
    fileCount: input.files.length,
    hasDiffSnapshot: input.diff.length > 0,
    hasGitSnapshot: input.gitSnapshot.length > 0,
  });
  const scope = agent({
    id: "scope-review-surface",
    title: "Scope review surface",
    agentId: exploreAgentId,
    prompt:
      "Scope this code review. Identify changed files, likely intent, touched layers, highest-risk areas, and which review lanes should run. Use repository evidence; do not assume the diff is complete if refs are provided.\\n\\n" +
      renderReviewInput(input),
    outputSchema: scopeSchema(),
  });

  const lanes = selectReviewLanes(scope.structuredOutput.lanes);
  log("Selected deep review lanes", { lanes: lanes });

  phase("lane-review", { lanes: lanes });
  const laneReviews = parallelAgents(
    lanes.map(function (lane) {
      return {
        id: "review-" + lane,
        title: "Review lane: " + lane,
        agentId: reasoningAgentId,
        prompt:
          readOnlyReviewPrompt +
          lanePrompt(lane) +
          "\\n\\nReview target:\\n" +
          renderReviewInput(input) +
          "\\n\\nScoped review surface:\\n" +
          JSON.stringify(scope.structuredOutput, null, 2) +
          "\\n\\nReturn only concrete, actionable findings with file paths and evidence. Prefer an empty issues array over speculative feedback.",
        outputSchema: issueListSchema(),
      };
    })
  );
  const laneIssues = flatten(
    laneReviews.map(function (review) {
      return review.structuredOutput.issues || [];
    })
  );
  log("Lane review produced candidate issues", { count: laneIssues.length });

  phase("triage-dedupe", { candidateCount: laneIssues.length });
  const triage = agent({
    id: "triage-candidate-issues",
    title: "Triage and dedupe review findings",
    agentId: reasoningAgentId,
    prompt:
      readOnlyReviewPrompt +
      "Deduplicate and triage these candidate code review findings. Merge duplicates, drop vague or non-actionable items, normalize severity, and preserve concrete evidence.\\n\\n" +
      "Review target:\\n" +
      renderReviewInput(input) +
      "\\n\\nCandidate issues:\\n" +
      JSON.stringify(laneIssues, null, 2),
    outputSchema: issueListSchema(),
  });
  const candidates = (triage.structuredOutput.issues || []).slice(0, maxCandidates);
  log("Triaged candidate issues", {
    candidateCount: triage.structuredOutput.issues.length,
    selectedCount: candidates.length,
  });

  phase("adversarial-verification", { candidateCount: candidates.length });
  const verificationResults = candidates.length > 0
    ? parallelAgents(
        candidates.map(function (issue, index) {
          return {
            id: "verify-issue-" + index,
            title: "Verify review finding " + (index + 1),
            agentId: reasoningAgentId,
            prompt:
              readOnlyReviewPrompt +
              "Adversarially verify this code review finding. Try to disprove it. Inspect relevant code paths and tests. Decide whether it is valid, duplicate, overstated, not reproducible, or needs more information.\\n\\n" +
              "Review target:\\n" +
              renderReviewInput(input) +
              "\\n\\nFinding:\\n" +
              JSON.stringify(issue, null, 2),
            outputSchema: verificationSchema(),
          };
        })
      )
    : [];
  const verifications = verificationResults.map(function (verification) {
    return verification.structuredOutput;
  });
  log("Verified candidate issues", { count: verifications.length });

  phase("final-synthesis", {
    candidateCount: candidates.length,
    verificationCount: verifications.length,
  });
  const final = agent({
    id: "synthesize-review",
    title: "Synthesize final deep review",
    agentId: reasoningAgentId,
    prompt:
      readOnlyReviewPrompt +
      "Write the final code review. Include only findings that remain actionable after adversarial verification. Use severity P0-P4, file paths, and concrete evidence. If there are no verified issues, say so clearly. Include questions and a validation plan.\\n\\n" +
      "Scoped review surface:\\n" +
      JSON.stringify(scope.structuredOutput, null, 2) +
      "\\n\\nTriaged issues:\\n" +
      JSON.stringify(candidates, null, 2) +
      "\\n\\nVerification results:\\n" +
      JSON.stringify(verifications, null, 2),
    outputSchema: finalSynthesisSchema(),
  });

  return {
    reportMarkdown: final.reportMarkdown,
    structuredOutput: {
      target: input.target,
      scope: scope.structuredOutput,
      laneIssues: laneIssues,
      triagedIssues: candidates,
      verification: verifications,
      final: final.structuredOutput,
    },
  };
}

function normalizeDeepReviewArgs(args) {
  const normalized = {
    target: "current workspace changes",
    baseRef: "",
    headRef: "",
    diff: "",
    files: [],
    instructions: "",
    gitSnapshot: "",
    explicitDiff: false,
    explicitFiles: false,
    maxCandidates: 12,
  };

  if (typeof args === "string" && args.trim()) {
    normalized.target = args.trim();
    return normalized;
  }

  if (!args || typeof args !== "object") {
    return normalized;
  }

  if (typeof args.target === "string" && args.target.trim()) normalized.target = args.target.trim();
  else if (typeof args.input === "string" && args.input.trim()) normalized.target = args.input.trim();
  else if (typeof args.pr === "string" && args.pr.trim()) normalized.target = args.pr.trim();
  else if (typeof args.branch === "string" && args.branch.trim()) normalized.target = args.branch.trim();

  if (typeof args.baseRef === "string") normalized.baseRef = args.baseRef.trim();
  else if (typeof args.base === "string") normalized.baseRef = args.base.trim();

  if (typeof args.headRef === "string") normalized.headRef = args.headRef.trim();
  else if (typeof args.head === "string") normalized.headRef = args.head.trim();

  if (typeof args.diff === "string" && args.diff.trim().length > 0) {
    normalized.diff = args.diff;
    normalized.explicitDiff = true;
  }
  if (typeof args.instructions === "string") normalized.instructions = args.instructions.trim();
  else if (typeof args.notes === "string") normalized.instructions = args.notes.trim();

  if (Array.isArray(args.files)) {
    normalized.files = args.files.filter(function (file) {
      return typeof file === "string" && file.trim().length > 0;
    }).map(function (file) {
      return file.trim();
    });
    normalized.explicitFiles = normalized.files.length > 0;
  }

  if (typeof args.maxCandidates === "number" && args.maxCandidates > 0) {
    normalized.maxCandidates = Math.min(20, Math.max(1, Math.floor(args.maxCandidates)));
  }

  return normalized;
}

function collectGitReviewContext(action, input, log) {
  const gitInput = buildGitActionInput(input);
  let status = null;
  try {
    status = action.git.status({ id: "git-status" }).output;
  } catch (error) {
    log("Git workflow actions unavailable; continuing with caller-provided review context", {
      error: formatError(error),
    });
    return null;
  }

  const changedFiles = tryGitAction(log, "git.changedFiles", function () {
    return action.git.changedFiles({ id: "git-changed-files", input: gitInput }).output;
  });
  const diffStat = tryGitAction(log, "git.diffStat", function () {
    return action.git.diffStat({ id: "git-diff-stat", input: gitInput }).output;
  });
  const diff = tryGitAction(log, "git.diff", function () {
    return action.git.diff({ id: "git-diff", input: gitInput }).output;
  });
  const commits = tryGitAction(log, "git.commitsBetween", function () {
    const commitsInput = copyGitActionInput(gitInput);
    commitsInput.limit = 20;
    return action.git.commitsBetween({ id: "git-commits-between", input: commitsInput }).output;
  });
  const context = {
    status: status,
    changedFiles: changedFiles,
    diffStat: diffStat,
    diff: diff,
    commits: commits,
  };
  const files = collectGitFiles(context);
  log("Captured Git review context", {
    branch: status.branch,
    fileCount: files.length,
    hasDiff: diff != null && (hasText(diff.branch) || hasText(diff.staged) || hasText(diff.unstaged)),
  });
  return context;
}

function tryGitAction(log, name, fn) {
  try {
    return fn();
  } catch (error) {
    log("Git workflow action failed; continuing with partial review context", {
      action: name,
      error: formatError(error),
    });
    return null;
  }
}

function buildGitActionInput(input) {
  const gitInput = {};
  if (input.baseRef) gitInput.base = input.baseRef;
  if (input.headRef) gitInput.head = input.headRef;
  return gitInput;
}

function copyGitActionInput(input) {
  const copy = {};
  if (input.base) copy.base = input.base;
  if (input.head) copy.head = input.head;
  return copy;
}

function applyGitContextToReviewInput(input, gitContext) {
  if (gitContext == null) return;
  if (!input.explicitFiles) {
    const files = collectGitFiles(gitContext);
    if (files.length > 0) input.files = files;
  }
  if (!input.explicitDiff && gitContext.diff != null) {
    const diff = renderGitDiff(gitContext.diff);
    if (diff.length > 0) input.diff = truncateText(diff, 60000);
  }
  input.gitSnapshot = renderGitSnapshot(gitContext);
}

function collectGitFiles(gitContext) {
  const files = [];
  if (gitContext == null) return files;
  if (gitContext.changedFiles != null) {
    addFileEntries(files, gitContext.changedFiles.branch);
    addFileEntries(files, gitContext.changedFiles.staged);
    addFileEntries(files, gitContext.changedFiles.unstaged);
    addFilePaths(files, gitContext.changedFiles.untracked);
  }
  if (gitContext.status != null) {
    addFileEntries(files, gitContext.status.staged);
    addFileEntries(files, gitContext.status.unstaged);
    addFilePaths(files, gitContext.status.untracked);
  }
  return files;
}

function addFileEntries(files, entries) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      addFilePath(files, entry.path);
      addFilePath(files, entry.oldPath);
    }
  }
}

function addFilePaths(files, paths) {
  if (!Array.isArray(paths)) return;
  for (const path of paths) {
    addFilePath(files, path);
  }
}

function addFilePath(files, path) {
  if (typeof path !== "string") return;
  const trimmed = path.trim();
  if (trimmed.length === 0 || files.indexOf(trimmed) !== -1) return;
  files.push(trimmed);
}

function renderGitSnapshot(gitContext) {
  const sections = [];
  if (gitContext.status != null) {
    const status = gitContext.status;
    sections.push(
      "Repository status: branch " +
        valueOrUnknown(status.branch) +
        (status.upstream ? " tracking " + status.upstream : "") +
        "; staged " +
        arrayLength(status.staged) +
        "; unstaged " +
        arrayLength(status.unstaged) +
        "; untracked " +
        arrayLength(status.untracked)
    );
  }
  const files = collectGitFiles(gitContext);
  if (files.length > 0) {
    sections.push("Changed files from parent workspace Git snapshot: " + files.join(", "));
  }
  if (gitContext.commits != null && Array.isArray(gitContext.commits.commits)) {
    const commits = gitContext.commits.commits;
    if (commits.length > 0) {
      sections.push(
        "Commits since " +
          valueOrUnknown(gitContext.commits.base) +
          ":\\n" +
          commits.map(function (commit) {
            return "- " + valueOrUnknown(commit.shortHash) + " " + valueOrUnknown(commit.subject);
          }).join("\\n")
      );
    }
  }
  if (gitContext.diffStat != null) {
    const statSections = [];
    if (hasText(gitContext.diffStat.branch)) statSections.push("Branch diff stat:\\n" + gitContext.diffStat.branch);
    if (hasText(gitContext.diffStat.staged)) statSections.push("Staged diff stat:\\n" + gitContext.diffStat.staged);
    if (hasText(gitContext.diffStat.unstaged)) statSections.push("Unstaged diff stat:\\n" + gitContext.diffStat.unstaged);
    if (statSections.length > 0) sections.push(statSections.join("\\n\\n"));
  }
  if (gitContext.status != null && arrayLength(gitContext.status.untracked) > 0) {
    sections.push(
      "Untracked file contents are not included in the automatic diff snapshot; review agents only receive their paths unless the caller supplied args.diff."
    );
  }
  if (gitContext.diff != null && isDiffTruncated(gitContext.diff)) {
    sections.push("One or more automatic diff sections were truncated by workflow action output limits.");
  }
  return sections.join("\\n\\n");
}

function renderGitDiff(diff) {
  const parts = [];
  if (hasText(diff.branch)) {
    parts.push("Branch diff (" + valueOrUnknown(diff.base) + ".." + valueOrUnknown(diff.head) + ")\\n" + diff.branch);
  }
  if (hasText(diff.staged)) {
    parts.push("Staged diff\\n" + diff.staged);
  }
  if (hasText(diff.unstaged)) {
    parts.push("Unstaged diff\\n" + diff.unstaged);
  }
  if (isDiffTruncated(diff)) {
    parts.push("NOTE: one or more diff sections were truncated by workflow action output limits.");
  }
  return parts.join("\\n\\n");
}

function isDiffTruncated(diff) {
  return Boolean(
    diff &&
      diff.truncated &&
      (diff.truncated.branch || diff.truncated.staged || diff.truncated.unstaged)
  );
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\\n[truncated by deep-review-workflow after " + maxLength + " characters]";
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function valueOrUnknown(value) {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function formatError(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
}

function renderReviewInput(input) {
  return [
    "Target: " + input.target,
    input.baseRef ? "Base ref: " + input.baseRef : "",
    input.headRef ? "Head ref: " + input.headRef : "",
    input.files.length > 0 ? "Files: " + input.files.join(", ") : "",
    input.gitSnapshot ? "Git snapshot:\\n" + input.gitSnapshot : "",
    input.instructions ? "Reviewer instructions: " + input.instructions : "",
    input.diff ? "Diff snapshot:\\n~~~diff\\n" + input.diff + "\\n~~~" : "",
  ].filter(Boolean).join("\\n");
}

function selectReviewLanes(lanes) {
  const defaults = ["correctness", "tests", "architecture"];
  const allowed = {
    correctness: true,
    tests: true,
    architecture: true,
    "security-reliability": true,
    "ux-a11y": true,
    "docs-dx": true,
  };
  const requested = Array.isArray(lanes) && lanes.length > 0 ? lanes : defaults;
  const result = [];
  for (const lane of requested) {
    if (allowed[lane] && result.indexOf(lane) === -1) {
      result.push(lane);
    }
  }
  for (const fallback of defaults) {
    if (result.indexOf(fallback) === -1) {
      result.push(fallback);
    }
  }
  return result.slice(0, 6);
}

function lanePrompt(lane) {
  const prompts = {
    correctness: "Review for logic bugs, edge cases, races, state-machine violations, and broken invariants.",
    tests: "Review test coverage, determinism, missing regression tests, and validation commands.",
    architecture: "Review consistency with existing architecture, boundaries, naming, abstractions, and maintainability.",
    "security-reliability": "Review security, trust boundaries, path traversal, injection, data corruption, reliability, and performance risks.",
    "ux-a11y": "Review user-facing behavior, accessibility, keyboard flow, visual consistency, and empty/loading/error states.",
    "docs-dx": "Review documentation, developer experience, scripts, public API clarity, and migration concerns.",
  };
  return prompts[lane] || prompts.correctness;
}

function issueListSchema() {
  return {
    type: "object",
    required: ["issues"],
    additionalProperties: false,
    properties: {
      issues: {
        type: "array",
        items: issueSchema(),
      },
    },
  };
}

function issueSchema() {
  return {
    type: "object",
    required: ["id", "severity", "category", "title", "rationale", "evidence", "filePaths", "confidence"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      severity: { type: "string", enum: ["P0", "P1", "P2", "P3", "P4"] },
      category: { type: "string" },
      title: { type: "string" },
      rationale: { type: "string" },
      evidence: { type: "string" },
      filePaths: { type: "array", items: { type: "string" } },
      suggestedFix: { type: "string" },
      validation: { type: "string" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
  };
}

function scopeSchema() {
  return {
    type: "object",
    required: ["summary", "files", "riskAreas", "lanes"],
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      riskAreas: { type: "array", items: { type: "string" } },
      lanes: {
        type: "array",
        items: {
          type: "string",
          enum: ["correctness", "tests", "architecture", "security-reliability", "ux-a11y", "docs-dx"],
        },
      },
    },
  };
}

function verificationSchema() {
  return {
    type: "object",
    required: ["issueId", "verdict", "confidence", "rationale"],
    additionalProperties: false,
    properties: {
      issueId: { type: "string" },
      verdict: { type: "string", enum: ["valid", "duplicate", "overstated", "not-repro", "needs-info"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      rationale: { type: "string" },
      evidence: { type: "string" },
      suggestedSeverity: { type: "string", enum: ["P0", "P1", "P2", "P3", "P4"] },
    },
  };
}

function finalSynthesisSchema() {
  return {
    type: "object",
    required: ["verifiedIssueCount", "risk", "validationPlan"],
    additionalProperties: false,
    properties: {
      verifiedIssueCount: { type: "number" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      validationPlan: { type: "array", items: { type: "string" } },
      discardedIssueCount: { type: "number" },
    },
  };
}

function flatten(arrays) {
  const out = [];
  for (const array of arrays) {
    for (const item of array) {
      out.push(item);
    }
  }
  return out;
}
`,
  },
];
