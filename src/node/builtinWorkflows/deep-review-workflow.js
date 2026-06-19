const s = mux.schema;

export const metadata = {
  description:
    "Coordinate adversarial review agents to find, verify, synthesize, and optionally fix code review findings.",
  argsSchema: s.object({
    input: s.optional(s.string()),
    target: s.optional(s.string({ positional: true })),
    pr: s.optional(s.string()),
    branch: s.optional(s.string()),
    baseRef: s.optional(s.string({ aliases: ["--base"] })),
    base: s.optional(s.string()),
    headRef: s.optional(s.string({ aliases: ["--head"] })),
    head: s.optional(s.string()),
    diff: s.optional(s.string()),
    files: s.optional(s.array(s.string())),
    instructions: s.optional(s.string()),
    notes: s.optional(s.string()),
    includeGitContext: s.optional(s.boolean({ default: false, aliases: ["--git-context"] })),
    maxCandidates: s.optional(
      s.integer({ default: 12, minimum: 1, maximum: 20, aliases: ["--max-candidates"] })
    ),
    fix: s.optional(
      s.boolean({ default: false, aliases: ["--fix"], negatedAliases: ["--no-fix"] })
    ),
    loop: s.optional(
      s.boolean({ default: false, aliases: ["--loop"], negatedAliases: ["--no-loop"] })
    ),
    maxFixes: s.optional(
      s.integer({ default: 5, minimum: 1, maximum: 20, aliases: ["--max-fixes"] })
    ),
    maxLoopIterations: s.optional(
      s.integer({ default: 5, minimum: 1, maximum: 10, aliases: ["--max-loop-iterations"] })
    ),
    fixIssueIds: s.optional(s.array(s.string())),
  }),
};

// Git context and apply preflight are collected by read-only agents with
// structuredOutput; optional fixes are made by an exec child and integrated
// through the workflow patch boundary.
const SCHEMA = s;
const WORKFLOW_UTILS = mux.utils;
const EXPLORE_AGENT_ID = "explore";
const EXEC_AGENT_ID = "exec";
const MAX_PARALLEL_AGENTS = 12;
const READ_ONLY_REVIEW_PROMPT =
  "This is a read-only deep code review task. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report findings.\n\n";
const REVIEW_LANES = ["correctness", "tests", "architecture", "security", "ux", "maintainability"];
const SEVERITIES = ["P0", "P1", "P2", "P3", "P4"];
const VERDICTS = ["confirmed", "refuted", "unclear"];

export default async function deepReviewWorkflow({ args, phase, log, agent }) {
  const input = normalizeDeepReviewArgs(args);
  if (input.loop && !input.fix) {
    throw new Error("--loop requires --fix for deep-review-workflow");
  }

  const passes = [];
  const iterations = input.loop ? input.maxLoopIterations : 1;
  let remainingFixes = input.maxFixes;
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const passInput = Object.assign({}, input, { maxFixes: remainingFixes });
    const pass = await runDeepReviewPass({
      input: passInput,
      iteration: input.loop ? iteration : 0,
      phase,
      log,
      agent,
    });
    passes.push(pass);

    const fixedCount = countFixedIssues(pass);
    remainingFixes = Math.max(0, remainingFixes - fixedCount);
    if (!input.loop || fixedCount === 0) break;
  }

  if (passes.length === 1) return passes[0];
  return buildLoopReport(input, passes, remainingFixes);
}

async function runDeepReviewPass(context) {
  const input = context.input;
  const suffix = context.iteration > 0 ? "-" + context.iteration : "";

  context.phase("git-context", withIteration({ target: input.target }, context.iteration));
  const gitContext = shouldCollectGitContext(input)
    ? collectGitReviewContextAgent(context.agent, input, suffix)
    : explicitGitContext(input);
  const reviewInput = Object.assign({}, input, {
    gitContext,
    files: mergeUniqueStrings(input.files.concat(collectGitContextFiles(gitContext))),
    diff: input.diff || compactText(gitContext.diff, 70000),
  });
  context.log("Captured deep-review Git context via sub-agent", {
    fileCount: reviewInput.files.length,
    hasDiff: Boolean(reviewInput.diff),
    failureCount: WORKFLOW_UTILS.asArray(gitContext.failures).length,
  });

  context.phase(
    "scope",
    withIteration(
      {
        target: reviewInput.target,
        fileCount: reviewInput.files.length,
        hasDiff: reviewInput.diff.length > 0,
      },
      context.iteration
    )
  );
  const scope = context.agent({
    id: stepId("scope-review-surface", suffix),
    title: "Scope review surface",
    agentId: EXPLORE_AGENT_ID,
    prompt:
      READ_ONLY_REVIEW_PROMPT +
      "Scope this code review. Identify intent, changed files, touched layers, highest-risk areas, and which review lanes should run. Use repository evidence; do not assume the diff is complete if refs are provided.\n\n" +
      renderReviewInput(reviewInput),
    outputSchema: scopeSchema(),
  });
  const lanes = selectReviewLanes(scope.structuredOutput && scope.structuredOutput.lanes);
  context.log("Selected deep-review lanes", withIteration({ lanes }, context.iteration));

  context.phase("lane-review", withIteration({ lanes }, context.iteration));
  const laneReviews = mux.parallelMap({
    items: lanes,
    stepId: function (lane) {
      return stepId("review-" + lane, suffix);
    },
    title: function (lane) {
      return "Review lane: " + lane;
    },
    agentId: EXEC_AGENT_ID,
    prompt: function (lane) {
      return (
        READ_ONLY_REVIEW_PROMPT +
        lanePrompt(lane) +
        "\n\nReview input:\n" +
        renderReviewInput(reviewInput) +
        "\n\nScoped review surface:\n" +
        JSON.stringify(scope.structuredOutput, null, 2) +
        "\n\nReturn concrete, actionable findings only. Prefer an empty issues array over speculative feedback."
      );
    },
    outputSchema: issueListSchema(),
    maxParallel: Math.min(MAX_PARALLEL_AGENTS, lanes.length),
  });
  const rawIssues = flatten(
    laneReviews.map(function (review) {
      return WORKFLOW_UTILS.asArray(review.structuredOutput && review.structuredOutput.issues);
    })
  );

  if (rawIssues.length === 0) {
    return noIssueReviewResult(reviewInput, gitContext, scope.structuredOutput, laneReviews);
  }

  context.phase(
    "triage-dedupe",
    withIteration({ candidateCount: rawIssues.length }, context.iteration)
  );
  const triage = context.agent({
    id: stepId("triage-candidate-issues", suffix),
    title: "Triage and dedupe review findings",
    agentId: EXEC_AGENT_ID,
    prompt:
      READ_ONLY_REVIEW_PROMPT +
      "Deduplicate and rank candidate review findings. Keep only issues grounded in repository evidence. Assign stable issue ids like DR-1, DR-2.\n\n" +
      "Review input:\n" +
      renderReviewInput(reviewInput) +
      "\n\nCandidate issues:\n" +
      JSON.stringify(rawIssues, null, 2),
    outputSchema: issueListSchema(),
  });
  const candidates = WORKFLOW_UTILS.asArray(
    triage.structuredOutput && triage.structuredOutput.issues
  ).slice(0, input.maxCandidates);

  context.phase(
    "adversarial-verification",
    withIteration({ candidateCount: candidates.length }, context.iteration)
  );
  const verifications = mux.parallelMap({
    items: candidates,
    stepId: function (_issue, index) {
      return stepId("verify-issue-" + index, suffix);
    },
    title: function (_issue, index) {
      return "Verify review issue " + (index + 1);
    },
    agentId: EXEC_AGENT_ID,
    prompt: function (issue) {
      return (
        READ_ONLY_REVIEW_PROMPT +
        "Adversarially verify this code review finding. Try to disprove it first using repository evidence. Return confirmed only when the issue is reproducible or strongly evidenced.\n\n" +
        "Issue:\n" +
        JSON.stringify(issue, null, 2) +
        "\n\nReview input:\n" +
        renderReviewInput(reviewInput)
      );
    },
    outputSchema: verificationSchema(),
    maxParallel: Math.min(MAX_PARALLEL_AGENTS, candidates.length),
  });

  const verified = mergeVerifiedIssues(candidates, verifications);
  context.phase(
    "final-synthesis",
    withIteration({ verifiedCount: countConfirmed(verified) }, context.iteration)
  );
  const final = context.agent({
    id: stepId("synthesize-review", suffix),
    title: "Synthesize deep review report",
    agentId: EXEC_AGENT_ID,
    prompt:
      READ_ONLY_REVIEW_PROMPT +
      "Synthesize a concise code review report. Include only verified or explicitly unclear findings, grouped by severity. Explain refuted candidates briefly only if useful.\n\n" +
      "Review input:\n" +
      renderReviewInput(reviewInput) +
      "\n\nScope:\n" +
      JSON.stringify(scope.structuredOutput, null, 2) +
      "\n\nVerified findings:\n" +
      JSON.stringify(verified, null, 2),
    outputSchema: synthesisSchema(),
  });

  const result = {
    reportMarkdown: final.reportMarkdown,
    structuredOutput: {
      mode: "review-only",
      gitContext,
      scope: scope.structuredOutput,
      laneReviews: laneReviews.map(function (review) {
        return review.structuredOutput;
      }),
      candidates,
      verifications: verifications.map(function (verification) {
        return verification.structuredOutput;
      }),
      final: final.structuredOutput,
    },
  };

  const fixableIssues = selectFixableIssues(input, final.structuredOutput, verified);
  if (!input.fix || fixableIssues.length === 0) return result;

  const deterministicSkipReason = autoFixSkipReason(input, gitContext);
  if (deterministicSkipReason) {
    return appendFixSkipped(result, deterministicSkipReason, {
      ok: false,
      reason: deterministicSkipReason,
    });
  }

  context.phase(
    "fix-preflight",
    withIteration({ fixableCount: fixableIssues.length }, context.iteration)
  );
  const preflight = collectGitPreflightAgent(context.agent, input, gitContext, suffix);
  if (!preflight.ok) {
    return appendFixSkipped(result, preflight.reason || "Auto-fix preflight failed.", preflight);
  }

  context.phase("fix", withIteration({ fixableCount: fixableIssues.length }, context.iteration));
  const fixer = context.agent({
    id: stepId("fix-review-findings", suffix),
    title: "Fix verified review findings",
    agentId: EXEC_AGENT_ID,
    prompt: fixPrompt(reviewInput, fixableIssues, preflight),
    outputSchema: fixerSchema(),
  });
  const fixerOutput = fixer.structuredOutput || { madeChanges: false, fixedIssueIds: [] };
  if (!fixerOutput.madeChanges)
    return appendFixNoChanges(result, fixer.reportMarkdown, fixerOutput);

  context.phase("apply-fixes", withIteration({ madeChanges: true }, context.iteration));
  const applySpec = { id: stepId("apply-review-fixes", suffix), source: fixer };
  if (preflight.expectedHeadSha) applySpec.expectedHeadSha = preflight.expectedHeadSha;
  const applied = await mux.patch.applySafely(applySpec);
  return appendFixApplied(result, fixer.reportMarkdown, fixerOutput, applied);
}

function autoFixSkipReason(input, gitContext) {
  if (input.diff)
    return "Auto-fix requires a local current workspace target, not an explicit diff.";
  if (input.files.length > 0) {
    return "Auto-fix requires a Git-derived local review target, not explicit file snapshots.";
  }
  if (looksNonLocalTarget(input.target))
    return "Auto-fix requires a local current workspace target.";
  const status = gitContext && gitContext.status;
  if (!status || !status.headSha) {
    return "Auto-fix requires a reviewed local Git branch and HEAD snapshot.";
  }
  return "";
}

function looksNonLocalTarget(target) {
  const textValue = String(target || "").trim();
  return /^https?:\/\//i.test(textValue) || /^git@/i.test(textValue);
}

function collectGitReviewContextAgent(agent, input, suffix) {
  return agent({
    id: stepId("git-review-context", suffix),
    title: "Collect Git review context",
    agentId: EXPLORE_AGENT_ID,
    isolation: "none",
    prompt:
      READ_ONLY_REVIEW_PROMPT +
      "Use bash/git in your workspace to collect a bounded review snapshot. Return branch/status metadata, changed files, diff stat, bounded diff text, relevant commits, failures, and limitations as structuredOutput.\n\n" +
      "Requested refs and target:\n" +
      JSON.stringify(
        {
          target: input.target,
          baseRef: input.baseRef,
          headRef: input.headRef,
          explicitFiles: input.files,
          explicitDiffProvided: input.diff.length > 0,
        },
        null,
        2
      ) +
      "\n\nSuggested commands: git status --short --branch, git rev-parse --abbrev-ref HEAD, git rev-parse HEAD, git diff --stat, git diff --name-status, git diff, and git log --oneline. If base/head refs are omitted, compare against origin/HEAD, main, master, or trunk when available. Keep diff text bounded and set limitations for truncation or unavailable refs.",
    outputSchema: gitReviewContextSchema(),
  }).structuredOutput;
}

function collectGitPreflightAgent(agent, input, gitContext, suffix) {
  return agent({
    id: stepId("git-preflight", suffix),
    title: "Check Git apply preflight",
    agentId: EXPLORE_AGENT_ID,
    isolation: "none",
    prompt:
      READ_ONLY_REVIEW_PROMPT +
      "Use bash/git to decide whether applying a child patch is safe. Return ok=false with a clear reason when the worktree is dirty, HEAD changed from the reviewed snapshot, or the requested head is not current.\n\n" +
      "Reviewed context:\n" +
      JSON.stringify({ input, gitStatus: gitContext && gitContext.status }, null, 2),
    outputSchema: gitPreflightSchema(),
  }).structuredOutput;
}

function explicitGitContext(input) {
  return {
    baseRef: input.baseRef,
    headRef: input.headRef,
    status: emptyStatus(),
    changedFiles: { branch: input.files, staged: [], unstaged: [], untracked: [] },
    diffStat: "",
    diff: input.diff,
    commits: [],
    failures: [],
    limitations: ["Used explicit diff/files from workflow args instead of collecting Git context."],
    hasReviewableChanges: input.diff.length > 0 || input.files.length > 0,
  };
}

function renderReviewInput(input) {
  return (
    "Target: " +
    input.target +
    "\nInstructions: " +
    (input.instructions || "(none)") +
    "\nRefs: " +
    JSON.stringify({ baseRef: input.baseRef, headRef: input.headRef }) +
    "\nFiles:\n" +
    JSON.stringify(input.files, null, 2) +
    "\nGit context:\n" +
    JSON.stringify(input.gitContext || null, null, 2) +
    "\nDiff or review text:\n" +
    compactText(input.diff, 70000)
  );
}

function lanePrompt(lane) {
  const prompts = {
    correctness:
      "Review for correctness defects, broken invariants, edge cases, data loss, race conditions, and error handling bugs.",
    tests:
      "Review test coverage. Flag missing tests only when they protect a real branch, invariant, or user-visible behavior.",
    architecture:
      "Review architecture and maintainability. Flag needless abstraction, duplicated logic, bad seams, and violations of existing module boundaries.",
    security:
      "Review for security/privacy issues, unsafe shell/filesystem/network handling, injection risks, secret exposure, and trust-boundary mistakes.",
    ux: "Review user-visible behavior, accessibility, keyboard flow, responsive layout, and confusing states when relevant.",
    maintainability:
      "Review for readability, type modeling, defensive assertions, cleanup, and consistency with nearby code style.",
  };
  return prompts[lane] || prompts.correctness;
}

function fixPrompt(input, issues, preflight) {
  return (
    "Fix the verified code review findings below. Make minimal surgical edits only. Do not open a PR or push. Run the most relevant validation commands and commit your changes locally so the parent workflow can apply your patch artifact. If a finding is unsafe or not actually fixable, skip it with a reason.\n\n" +
    "Apply preflight:\n" +
    JSON.stringify(preflight, null, 2) +
    "\n\nReview input:\n" +
    renderReviewInput(input) +
    "\n\nFindings to fix:\n" +
    JSON.stringify(issues, null, 2)
  );
}

function noIssueReviewResult(input, gitContext, scope, laneReviews) {
  return {
    reportMarkdown:
      "# Deep Review\n\nNo concrete review findings were produced by the selected lanes.",
    structuredOutput: {
      mode: "review-only",
      gitContext,
      scope,
      laneReviews: laneReviews.map(function (review) {
        return review.structuredOutput;
      }),
      candidates: [],
      verifications: [],
      final: { summary: "No concrete findings.", issues: [], questions: [] },
    },
  };
}

function appendFixSkipped(result, reason, preflight) {
  result.reportMarkdown += "\n\n---\n\n## Fix pass\n\n" + reason;
  result.structuredOutput.mode = "fix-skipped";
  result.structuredOutput.fix = { preflight, fixer: null, applied: null };
  return result;
}

function appendFixNoChanges(result, fixerMarkdown, fixerOutput) {
  result.reportMarkdown +=
    "\n\n---\n\n## Fix pass\n\nThe fixer did not make file changes.\n\n" + fixerMarkdown;
  result.structuredOutput.mode = "fixer-made-no-changes";
  result.structuredOutput.fix = { preflight: null, fixer: fixerOutput, applied: null };
  return result;
}

function appendFixApplied(result, fixerMarkdown, fixerOutput, applied) {
  result.reportMarkdown +=
    "\n\n---\n\n## Fix pass\n\n" +
    fixerMarkdown +
    "\n\n### Patch application\n\n- Status: " +
    (applied && applied.status ? applied.status : "unknown") +
    "\n- Success: " +
    (applied && applied.success ? "yes" : "no");
  result.structuredOutput.mode = "fix-attempted";
  result.structuredOutput.fix = { fixer: fixerOutput, applied };
  return result;
}

function buildLoopReport(input, passes, remainingFixes) {
  return {
    reportMarkdown:
      "# Deep Review Loop\n\n" +
      passes
        .map(function (pass, index) {
          return "## Pass " + (index + 1) + "\n\n" + pass.reportMarkdown;
        })
        .join("\n\n---\n\n"),
    structuredOutput: {
      mode: "loop",
      input,
      passes: passes.map(property("structuredOutput")),
      remainingFixes,
    },
  };
}

function scopeSchema() {
  return SCHEMA.object(
    {
      summary: SCHEMA.string(),
      intent: SCHEMA.string(),
      files: SCHEMA.array(SCHEMA.string()),
      risks: SCHEMA.array(SCHEMA.string()),
      lanes: SCHEMA.array(SCHEMA.enum(REVIEW_LANES)),
    },
    { additionalProperties: false }
  );
}

function issueSchema() {
  return SCHEMA.object(
    {
      id: SCHEMA.string(),
      title: SCHEMA.string(),
      severity: SCHEMA.enum(SEVERITIES),
      category: SCHEMA.string(),
      filePaths: SCHEMA.array(SCHEMA.string()),
      evidence: SCHEMA.string(),
      recommendation: SCHEMA.string(),
      confidence: SCHEMA.enum(["high", "medium", "low"]),
    },
    { additionalProperties: false }
  );
}

function issueListSchema() {
  return SCHEMA.object({ issues: SCHEMA.array(issueSchema()) }, { additionalProperties: false });
}

function verificationSchema() {
  return SCHEMA.object(
    {
      issueId: SCHEMA.string(),
      verdict: SCHEMA.enum(VERDICTS),
      confidence: SCHEMA.enum(["high", "medium", "low"]),
      evidence: SCHEMA.string(),
      notes: SCHEMA.string(),
    },
    { additionalProperties: false }
  );
}

function synthesisSchema() {
  return SCHEMA.object(
    {
      summary: SCHEMA.string(),
      issues: SCHEMA.array(
        SCHEMA.object(
          {
            id: SCHEMA.string(),
            title: SCHEMA.string(),
            severity: SCHEMA.enum(SEVERITIES),
            verdict: SCHEMA.enum(VERDICTS),
            filePaths: SCHEMA.array(SCHEMA.string()),
            evidence: SCHEMA.string(),
            recommendation: SCHEMA.string(),
          },
          { additionalProperties: false }
        )
      ),
      questions: SCHEMA.array(SCHEMA.string()),
      fixCandidateIds: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function fixerSchema() {
  return SCHEMA.object(
    {
      madeChanges: SCHEMA.boolean(),
      fixedIssueIds: SCHEMA.array(SCHEMA.string()),
      skippedIssues: SCHEMA.array(
        SCHEMA.object(
          { id: SCHEMA.string(), reason: SCHEMA.string() },
          { additionalProperties: false }
        )
      ),
      validation: SCHEMA.array(
        SCHEMA.object(
          { command: SCHEMA.string(), status: SCHEMA.string(), summary: SCHEMA.string() },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  );
}

function gitReviewContextSchema() {
  return SCHEMA.object(
    {
      baseRef: SCHEMA.string(),
      headRef: SCHEMA.string(),
      status: statusSchema(),
      changedFiles: SCHEMA.object(
        {
          branch: SCHEMA.array(SCHEMA.string()),
          staged: SCHEMA.array(SCHEMA.string()),
          unstaged: SCHEMA.array(SCHEMA.string()),
          untracked: SCHEMA.array(SCHEMA.string()),
        },
        { additionalProperties: false }
      ),
      diffStat: SCHEMA.string(),
      diff: SCHEMA.string(),
      commits: SCHEMA.array(SCHEMA.string()),
      failures: SCHEMA.array(failureSchema()),
      limitations: SCHEMA.array(SCHEMA.string()),
      hasReviewableChanges: SCHEMA.boolean(),
    },
    { additionalProperties: false }
  );
}

function gitPreflightSchema() {
  return SCHEMA.object(
    {
      ok: SCHEMA.boolean(),
      reason: SCHEMA.string(),
      branch: SCHEMA.string(),
      headSha: SCHEMA.string(),
      expectedHeadSha: SCHEMA.string(),
      clean: SCHEMA.boolean(),
      staged: SCHEMA.array(SCHEMA.string()),
      unstaged: SCHEMA.array(SCHEMA.string()),
      untracked: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function statusSchema() {
  return SCHEMA.object(
    {
      branch: SCHEMA.string(),
      upstream: SCHEMA.string(),
      headSha: SCHEMA.string(),
      ahead: SCHEMA.integer(),
      behind: SCHEMA.integer(),
      staged: SCHEMA.array(SCHEMA.string()),
      unstaged: SCHEMA.array(SCHEMA.string()),
      untracked: SCHEMA.array(SCHEMA.string()),
      clean: SCHEMA.boolean(),
    },
    { additionalProperties: false }
  );
}

function failureSchema() {
  return SCHEMA.object(
    { name: SCHEMA.string(), error: SCHEMA.string() },
    { additionalProperties: false }
  );
}

function normalizeDeepReviewArgs(args) {
  const raw = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const parsed = Object.assign(
    {},
    raw,
    parseFlagText(typeof args === "string" ? args : text(raw.input))
  );
  const target =
    firstText(parsed.target, parsed.input, parsed.pr, parsed.branch) || "current workspace changes";
  return {
    target,
    baseRef: firstText(parsed.baseRef, parsed.base) || "",
    headRef: firstText(parsed.headRef, parsed.head) || "",
    diff: text(parsed.diff),
    files: stringList(parsed.files),
    instructions: firstText(parsed.instructions, parsed.notes) || "",
    includeGitContext: Boolean(parsed.includeGitContext),
    maxCandidates: mux.utils.boundedInt(parsed.maxCandidates, 12, 1, 20),
    fix: Boolean(parsed.fix),
    loop: Boolean(parsed.loop),
    maxFixes: mux.utils.boundedInt(parsed.maxFixes, 5, 1, 20),
    maxLoopIterations: mux.utils.boundedInt(parsed.maxLoopIterations, 5, 1, 10),
    fixIssueIds: stringList(parsed.fixIssueIds),
  };
}

function parseFlagText(value) {
  const result = {};
  const tokens = tokenize(value);
  const target = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--fix") result.fix = true;
    else if (token === "--no-fix") result.fix = false;
    else if (token === "--loop") result.loop = true;
    else if (token === "--no-loop") result.loop = false;
    else if (token === "--git-context") result.includeGitContext = true;
    else if (
      token === "--base" ||
      token === "--head" ||
      token === "--max-candidates" ||
      token === "--max-fixes" ||
      token === "--max-loop-iterations"
    ) {
      index += 1;
      const key = token === "--base" ? "baseRef" : token === "--head" ? "headRef" : flagKey(token);
      result[key] = tokens[index] || "";
    } else if (token.indexOf("--") === 0) {
      target.push(token);
    } else {
      target.push(token);
    }
  }
  if (target.length > 0) result.target = target.join(" ");
  return result;
}

function flagKey(flag) {
  if (flag === "--max-candidates") return "maxCandidates";
  if (flag === "--max-fixes") return "maxFixes";
  return "maxLoopIterations";
}

function shouldCollectGitContext(input) {
  return input.includeGitContext || (!input.diff && input.files.length === 0);
}

function collectGitContextFiles(context) {
  if (!context || !context.changedFiles) return [];
  return mergeUniqueStrings([
    context.changedFiles.branch,
    context.changedFiles.staged,
    context.changedFiles.unstaged,
    context.changedFiles.untracked,
  ]);
}

function selectReviewLanes(rawLanes) {
  const selected = [];
  for (const lane of WORKFLOW_UTILS.asArray(rawLanes)) {
    if (REVIEW_LANES.indexOf(lane) !== -1 && selected.indexOf(lane) === -1) selected.push(lane);
  }
  return selected.length > 0 ? selected : ["correctness", "tests", "architecture", "security"];
}

function mergeVerifiedIssues(candidates, verifications) {
  return candidates.map(function (issue, index) {
    const verification = verifications[index] && verifications[index].structuredOutput;
    return Object.assign({}, issue, { verification });
  });
}

function selectFixableIssues(input, final, verified) {
  const selectedIds = stringList(input.fixIssueIds);
  const finalIds = stringList(final && final.fixCandidateIds);
  const wantedIds = selectedIds.length > 0 ? selectedIds : finalIds;
  return verified
    .filter(function (issue) {
      const verdict = issue.verification && issue.verification.verdict;
      const isWanted = wantedIds.length === 0 || wantedIds.indexOf(issue.id) !== -1;
      return verdict === "confirmed" && isWanted;
    })
    .slice(0, input.maxFixes);
}

function countConfirmed(verified) {
  return verified.filter(function (issue) {
    return issue.verification && issue.verification.verdict === "confirmed";
  }).length;
}

function countFixedIssues(pass) {
  const fix = pass && pass.structuredOutput && pass.structuredOutput.fix;
  const applied = fix && fix.applied;
  if (!applied || applied.success !== true || applied.status !== "applied") return 0;
  const fixed = fix.fixer;
  return fixed ? WORKFLOW_UTILS.asArray(fixed.fixedIssueIds).length : 0;
}

function withIteration(value, iteration) {
  return iteration > 0 ? Object.assign({ iteration }, value) : value;
}

function stepId(base, suffix) {
  return suffix ? base + suffix : base;
}

function emptyStatus() {
  return {
    branch: "",
    upstream: "",
    headSha: "",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    clean: true,
  };
}

function property(name) {
  return function (value) {
    return value && value[name];
  };
}

function firstText() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = text(arguments[index]);
    if (value) return value;
  }
  return "";
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    const itemText = text(item);
    if (itemText && result.indexOf(itemText) === -1) result.push(itemText);
  }
  return result;
}

function mergeUniqueStrings(values) {
  const result = [];
  for (const value of WORKFLOW_UTILS.asArray(values)) {
    if (Array.isArray(value)) {
      for (const nested of value) {
        if (text(nested) && result.indexOf(text(nested)) === -1) result.push(text(nested));
      }
    } else if (text(value) && result.indexOf(text(value)) === -1) result.push(text(value));
  }
  return result;
}

function tokenize(input) {
  return String(input || "")
    .split(/\s+/)
    .filter(Boolean);
}

function flatten(items) {
  return items.reduce(function (result, item) {
    return result.concat(WORKFLOW_UTILS.asArray(item));
  }, []);
}

function compactText(value, limit) {
  const textValue = typeof value === "string" ? value : "";
  if (textValue.length <= limit) return textValue;
  return (
    textValue.slice(0, limit) +
    "\n[truncated by deep-review-workflow after " +
    limit +
    " characters]"
  );
}
