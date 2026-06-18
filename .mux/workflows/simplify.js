const s = mux.schema;

export const metadata = {
  description:
    "Review current changes for reuse, quality, efficiency, and polish, then fix actionable issues.",
  argsSchema: s.object({
    target: s.optional(s.string({ positional: true })),
    fix: s.optional(
      s.boolean({
        default: true,
        aliases: ["--fix"],
        negatedAliases: ["--no-fix", "--review-only"],
      })
    ),
    reviewOnly: s.optional(s.boolean({ default: false })),
    baseRef: s.optional(s.string({ aliases: ["--base"] })),
    base: s.optional(s.string()),
    trunkRef: s.optional(s.string({ aliases: ["--trunk"] })),
    trunk: s.optional(s.string()),
    headRef: s.optional(s.string({ aliases: ["--head"] })),
    head: s.optional(s.string()),
    maxFindings: s.optional(
      s.integer({ default: 20, minimum: 1, aliases: ["--max-findings"] })
    ),
    help: s.optional(s.boolean({ default: false, aliases: ["--help", "-h"] })),
  }),
};

// Workflow files execute as self-contained JavaScript; keep small helpers inline instead of importing repo utilities.
const DEFAULT_MAX_FINDINGS = 20;
// Review agents get bounded diff text; synthesis/fix phases get metadata only.
const REVIEW_DIFF_CHAR_BUDGET = 60000;
const METADATA_ARRAY_ITEM_BUDGET = 200;
const DIFF_STAT_CHAR_BUDGET = 20000;
const REVIEW_EVIDENCE_ITEM_BUDGET = 3;
const REVIEW_EVIDENCE_CHAR_BUDGET = 500;
const NO_REVIEWABLE_CHANGES_SUMMARY = "No reviewable changes found.";
const GIT_CONTEXT_SOURCE = "parent-workflow-checkout";
const GIT_CONTEXT_PROVENANCE_NOTE =
  "Git context was captured from the parent workflow checkout before child agent workspaces were spawned. Child agent branches may differ; status.branch/upstream describe the reviewed parent checkout.";
const READ_ONLY_PROMPT =
  "This is a read-only review step. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report findings.";
const VALUE_FLAGS = [
  { name: "--base", key: "baseRef" },
  { name: "--trunk", key: "trunkRef" },
  { name: "--head", key: "headRef" },
  { name: "--max-findings", key: "maxFindings" },
];
const STATUS_ARRAY_FIELDS = ["staged", "unstaged", "untracked", "ignored"];
const CHANGED_FILE_ARRAY_FIELDS = ["branch", "staged", "unstaged", "untracked"];
const DIFF_FIELDS = ["branch", "staged", "unstaged"];
const REVIEW_AGENT_ID = "explore";
const EXEC_AGENT_ID = "exec";
const REVIEW_LANES = [
  {
    id: "reuse",
    title: "Simplify: code reuse review",
    instructions: [
      "Search for existing utilities and helpers that could replace newly written code.",
      "Flag new functions that duplicate existing functionality and name the existing function to use instead.",
      "Flag inline logic that could use an existing utility: string handling, path handling, environment checks, type guards, and similar patterns.",
    ],
  },
  {
    id: "quality",
    title: "Simplify: code quality review",
    instructions: [
      "Find redundant state, cached values that could be derived, and observers/effects that could be direct calls.",
      "Find parameter sprawl, copy-paste with slight variation, and leaky abstractions.",
      "Find stringly-typed code and unnecessary JSX wrappers that add no layout value.",
    ],
  },
  {
    id: "efficiency",
    title: "Simplify: efficiency review",
    instructions: [
      "Find redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns, and missed concurrency.",
      "Find hot-path bloat, recurring no-op updates, and updater wrappers that defeat same-reference no-op returns.",
      "Find TOCTOU existence pre-checks, unbounded memory, missing cleanup, and overly broad reads or loads.",
    ],
  },
  {
    id: "polish",
    title: "Simplify: polish review",
    instructions: [
      "Inspect the diff for AI-generated slop introduced by the current changes.",
      "Flag comments that restate the code, explain obvious behavior, or are inconsistent with nearby file style.",
      "Flag defensive checks, try/catch blocks, or fallback paths that are abnormal for the surrounding trusted codepath.",
      "Flag type escapes such as `as any` that bypass type issues instead of modeling them.",
      "Flag style inconsistencies that make new code look generated rather than maintained.",
      "Do not flag purposeful assertions, security checks, input validation, or comments that explain non-obvious rationale.",
    ],
  },
];

const SCHEMA = s;
const SEVERITY_SCHEMA = SCHEMA.enum(["high", "medium", "low"]);
const FINDING_CORE_PROPERTIES = {
  id: SCHEMA.string(),
  title: SCHEMA.string(),
  severity: SEVERITY_SCHEMA,
  filePaths: SCHEMA.array(SCHEMA.string()),
  rationale: SCHEMA.string(),
};
const FINDING_SCHEMA = SCHEMA.object({
  ...FINDING_CORE_PROPERTIES,
  recommendation: SCHEMA.string(),
  evidence: SCHEMA.array(SCHEMA.string()),
});
const REVIEW_SCHEMA = SCHEMA.object({
  summary: SCHEMA.string(),
  findings: SCHEMA.array(FINDING_SCHEMA),
});
const SYNTHESIS_FINDING_SCHEMA = SCHEMA.object({
  ...FINDING_CORE_PROPERTIES,
  fixPlan: SCHEMA.string(),
});
const SKIPPED_FINDING_SCHEMA = SCHEMA.object({
  id: SCHEMA.string(),
  title: SCHEMA.string(),
  reason: SCHEMA.string(),
});
const SYNTHESIS_SCHEMA = SCHEMA.object({
  summary: SCHEMA.string(),
  shouldFix: SCHEMA.boolean(),
  actionableFindings: SCHEMA.array(SYNTHESIS_FINDING_SCHEMA),
  skippedFindings: SCHEMA.array(SKIPPED_FINDING_SCHEMA),
  validationPlan: SCHEMA.array(SCHEMA.string()),
});
const FIXER_SCHEMA = SCHEMA.object({
  madeChanges: SCHEMA.boolean(),
  fixedFindingIds: SCHEMA.array(SCHEMA.string()),
  skippedFindings: SCHEMA.array(
    SCHEMA.object({
      id: SCHEMA.string(),
      reason: SCHEMA.string(),
    })
  ),
  validation: SCHEMA.array(
    SCHEMA.object({
      command: SCHEMA.string(),
      status: SCHEMA.string(),
      summary: SCHEMA.string(),
    })
  ),
});

const EMPTY_SYNTHESIS = {
  summary: NO_REVIEWABLE_CHANGES_SUMMARY,
  shouldFix: false,
  actionableFindings: [],
  skippedFindings: [],
  validationPlan: [],
};

export default async function simplifyWorkflow({ args, phase, log, action, agent }) {
  assert(action && agent, "workflow runtime APIs are required");

  const parsed = parseArgs(args);
  if (parsed.error) return usageResult(parsed.error);

  const input = parsed.input;
  if (input.help) return usageResult();

  phase("capture-context", { target: input.target || "current git changes", fix: input.fix });
  const gitContext = collectGitContext(action, input, log);
  const contexts = promptContexts(input, gitContext);
  log("Captured simplify context", {
    target: input.target || "current git changes",
    gitFailures: gitContext.failures.length,
    diffCompactions: mux.utils.asArray(contexts.outputGitContext.diff?.workflowCompactions).length,
  });

  if (shouldSkipForUntrackedContent(input, gitContext)) {
    const reason = untrackedChangesSkipReason();
    return {
      reportMarkdown: "## Simplify workflow result\n\n" + reason,
      structuredOutput: {
        mode: "untracked-changes-skip-review",
        gitContext: contexts.outputGitContext,
        reviews: [],
        synthesis: { ...EMPTY_SYNTHESIS, summary: reason },
      },
    };
  }

  if (!hasReviewableContext(input, gitContext)) {
    return {
      reportMarkdown: "## Simplify workflow result\n\n" + NO_REVIEWABLE_CHANGES_SUMMARY,
      structuredOutput: {
        mode: "no-reviewable-changes",
        gitContext: contexts.outputGitContext,
        reviews: [],
        synthesis: EMPTY_SYNTHESIS,
      },
    };
  }

  phase("review", {
    lanes: REVIEW_LANES.map(function (lane) {
      return lane.id;
    }),
  });
  const reviewOutputs = mux
    .parallelMap({
      items: REVIEW_LANES,
      stepId: function (lane) {
        return lane.id + "-review";
      },
      title: function (lane) {
        return lane.title;
      },
      agentId: REVIEW_AGENT_ID,
      prompt: function (lane) {
        return reviewPrompt(lane, input, contexts.review);
      },
      outputSchema: REVIEW_SCHEMA,
      maxParallel: REVIEW_LANES.length,
    })
    .map(function (review) {
      return mux.utils.mustObject(review.structuredOutput, "review structured output is required");
    });

  const rawFindingCount = reviewOutputs.reduce(function (count, output) {
    return count + output.findings.length;
  }, 0);

  phase("synthesize", { rawFindingCount: rawFindingCount });
  const synthesis = agent({
    id: "synthesize-simplify-findings",
    title: "Simplify: synthesize findings",
    agentId: EXEC_AGENT_ID,
    prompt: synthesisPrompt(input, contexts.compact, reviewOutputs),
    outputSchema: SYNTHESIS_SCHEMA,
  });
  const synthesized = mux.utils.mustObject(
    synthesis.structuredOutput,
    "synthesis structured output is required"
  );
  const actionableFindings = synthesized.actionableFindings;

  if (!input.fix || !synthesized.shouldFix || actionableFindings.length === 0) {
    return {
      reportMarkdown: reviewOnlyReport(input, synthesis.reportMarkdown),
      structuredOutput: {
        mode: input.fix ? "no-actionable-fixes" : "review-only",
        gitContext: contexts.outputGitContext,
        reviews: reviewOutputs,
        synthesis: synthesized,
      },
    };
  }

  // Workflow child workspaces do not inherit parent dirt; keep the review result but skip auto-fix.
  if (hasUncommittedChanges(gitContext)) {
    return skipFixResult(
      synthesis.reportMarkdown,
      uncommittedChangesSkipReason(),
      "uncommitted-changes-skip-fix",
      contexts.outputGitContext,
      reviewOutputs,
      synthesized
    );
  }
  if (!isRequestedHeadCurrent(gitContext.status, input)) {
    return skipFixResult(
      synthesis.reportMarkdown,
      nonCurrentHeadSkipReason(),
      "non-current-head-skip-fix",
      contexts.outputGitContext,
      reviewOutputs,
      synthesized
    );
  }

  phase("fix", { actionableFindingCount: actionableFindings.length });
  const fixer = agent({
    id: "fix-simplify-findings",
    title: "Simplify: fix actionable findings",
    agentId: EXEC_AGENT_ID,
    prompt: fixPrompt(contexts.compact, synthesized),
    outputSchema: FIXER_SCHEMA,
  });
  const fixerOutput = mux.utils.mustObject(
    fixer.structuredOutput,
    "fixer structured output is required"
  );

  if (!fixerOutput.madeChanges) {
    return {
      reportMarkdown:
        synthesis.reportMarkdown +
        "\n\n---\n\n## Fix pass\n\nThe fixer did not make file changes.\n\n" +
        fixer.reportMarkdown,
      structuredOutput: {
        mode: "fixer-made-no-changes",
        gitContext: contexts.outputGitContext,
        reviews: reviewOutputs,
        synthesis: synthesized,
        fix: { fixer: fixerOutput, applied: null },
      },
    };
  }

  phase("apply-fixes", { madeChanges: true });
  const applyPreflight = collectApplyPreflight(action, log, input, gitContext);
  if (applyPreflight.skippedReason) {
    return {
      reportMarkdown:
        synthesis.reportMarkdown +
        "\n\n---\n\n## Fix pass\n\n" +
        fixer.reportMarkdown +
        "\n\n### Patch application\n\n" +
        applyPreflight.skippedReason,
      structuredOutput: {
        mode: "apply-preflight-skip",
        gitContext: contexts.outputGitContext,
        reviews: reviewOutputs,
        synthesis: synthesized,
        fix: { fixer: fixerOutput, applied: applyPreflight },
      },
    };
  }

  const applied = await mux.patch.applySafely({
    id: "apply-simplify-fixes",
    source: fixer,
    expectedHeadSha: applyPreflight.expectedHeadSha,
  });

  return {
    reportMarkdown: fixReport(synthesis.reportMarkdown, fixer.reportMarkdown, applied),
    structuredOutput: {
      mode: "fix-attempted",
      gitContext: contexts.outputGitContext,
      reviews: reviewOutputs,
      synthesis: synthesized,
      fix: { fixer: fixerOutput, applied: applied },
    },
  };
}

function skipFixResult(
  synthesisMarkdown,
  reason,
  mode,
  outputGitContext,
  reviewOutputs,
  synthesized
) {
  return {
    reportMarkdown: synthesisMarkdown + "\n\n---\n\n## Simplify workflow result\n\n" + reason,
    structuredOutput: {
      mode: mode,
      gitContext: outputGitContext,
      reviews: reviewOutputs,
      synthesis: synthesized,
    },
  };
}

function collectApplyPreflight(action, log, input, gitContext) {
  const reviewedHeadSha = gitContext.status && gitContext.status.headSha;
  if (typeof reviewedHeadSha !== "string" || !reviewedHeadSha) {
    return failedApplyPreflight(
      "Auto-fix was skipped because the reviewed HEAD snapshot is unavailable."
    );
  }

  try {
    const preflightInput = {
      head: input.headRef || "HEAD",
      expectedHeadSha: reviewedHeadSha,
      requireClean: true,
    };
    const expectedBranch = reviewedBranchForPreflight(gitContext.status, input);
    // Commit-SHA heads have no branch invariant; omit the optional schema key
    // rather than passing QuickJS `undefined` through action input validation.
    if (expectedBranch !== undefined) preflightInput.expectedBranch = expectedBranch;

    const preflight = action.git.preflight({
      id: "apply-git-preflight",
      input: preflightInput,
      builtInOnly: true,
      cache: false,
    }).output;
    if (preflight && preflight.ok === true) {
      return { success: true, status: "ready", expectedHeadSha: reviewedHeadSha };
    }
    return failedApplyPreflight(
      (preflight && preflight.reason) ||
        "Auto-fix was skipped because fresh Git preflight did not pass."
    );
  } catch (error) {
    const message = formatError(error);
    log("Git preflight unavailable for simplify auto-fix", { error: message });
    return failedApplyPreflight(
      "Auto-fix was skipped because fresh Git preflight was unavailable."
    );
  }
}

function reviewedBranchForPreflight(reviewedStatus, input) {
  if (input.headRef && isGitCommitSha(input.headRef)) return undefined;
  const branch = reviewedStatus && typeof reviewedStatus.branch === "string" ? reviewedStatus.branch.trim() : "";
  return branch && branch !== "HEAD (no branch)" ? branch : undefined;
}

function failedApplyPreflight(reason) {
  return { success: false, status: "failed", skippedReason: reason, error: reason };
}

function nonCurrentHeadSkipReason() {
  return "Auto-fix was skipped because the requested `--head` is not the current checkout. Check out that branch/ref or pass the current commit SHA before applying fixes.";
}

function untrackedChangesSkipReason() {
  return "Review was skipped because untracked file contents are not available to workflow child workspaces. Add them with `git add -N` or commit them, then rerun `/workflow simplify`.";
}

function uncommittedChangesSkipReason() {
  return "Auto-fix was skipped because uncommitted changes are present. Commit or stash them, then rerun `/workflow simplify --fix`.";
}

function collectGitContext(action, input, log) {
  const requestedRefs = gitRefs(input);
  try {
    const context = action.git.reviewContext({
      id: "git-review-context",
      input: {
        ...requestedRefs,
        diffCharBudget: REVIEW_DIFF_CHAR_BUDGET,
        metadataCharBudget: DIFF_STAT_CHAR_BUDGET,
      },
      builtInOnly: true,
    }).output;
    if (!context || typeof context !== "object") {
      return emptyGitContext(input, requestedRefs, [
        { name: "reviewContext", error: "git.reviewContext returned no context" },
      ]);
    }
    return {
      ...context,
      target: input.target,
      refs: refsWithResolvedBase(requestedRefs, context.changedFiles),
      failures: mux.utils.asArray(context.failures),
    };
  } catch (error) {
    const failure = { name: "reviewContext", error: formatError(error) };
    log("Git review context action failed; continuing with empty simplify context", failure);
    return emptyGitContext(input, requestedRefs, [failure]);
  }
}

function emptyGitContext(input, refs, failures) {
  return {
    target: input.target,
    refs: refs,
    failures: failures,
    status: null,
    changedFiles: null,
    diffStat: null,
    diff: null,
  };
}

function gitRefs(input) {
  const refs = {};
  if (input.baseRef) refs.base = input.baseRef;
  if (input.trunkRef) refs.trunk = input.trunkRef;
  if (input.headRef) refs.head = input.headRef;
  return refs;
}

function refsWithResolvedBase(refs, changedFiles) {
  const base =
    changedFiles && typeof changedFiles === "object" && typeof changedFiles.base === "string"
      ? changedFiles.base
      : "";
  if (refs.base || refs.trunk || !base) return refs;
  return { ...refs, base };
}

// The diff actions only return branch/staged/unstaged hunks; untracked-only contexts
// are captured by changedFiles.

function isRequestedHeadCurrent(status, input) {
  if (!status || typeof status !== "object") return false;
  const currentHeadSha = typeof status.headSha === "string" ? status.headSha : "";
  const requestedHead = input && input.headRef ? input.headRef : "";
  const requestedHeadSha =
    typeof status.requestedHeadSha === "string"
      ? status.requestedHeadSha
      : requestedHead
        ? ""
        : currentHeadSha;
  if (!currentHeadSha || !requestedHeadSha || currentHeadSha !== requestedHeadSha) return false;

  if (!requestedHead || requestedHead === "HEAD") return true;

  const currentBranch = typeof status.branch === "string" ? status.branch : "";
  const currentBranchRef = currentBranch ? "refs/heads/" + currentBranch : "";
  const requestedHeadRef =
    typeof status.requestedHeadRef === "string" ? status.requestedHeadRef : "";
  if (requestedHeadRef) return Boolean(currentBranchRef && requestedHeadRef === currentBranchRef);
  if (currentBranch && (requestedHead === currentBranch || requestedHead === currentBranchRef)) {
    return true;
  }
  return isGitCommitSha(requestedHead);
}

function isGitCommitSha(value) {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

function shouldSkipForUntrackedContent(input, gitContext) {
  if (!hasUntrackedChanges(gitContext)) return false;
  return input.target
    ? targetNeedsUntrackedContent(input, gitContext)
    : hasOnlyUntrackedChanges(gitContext);
}

function targetNeedsUntrackedContent(input, gitContext) {
  if (!input.target) return true;
  const target = normalizedPath(input.target);
  if (!target) return false;
  if (target === ".") return true;
  return untrackedPaths(gitContext).some(function (path) {
    const untracked = normalizedPath(path);
    return untracked === target || untracked.startsWith(target + "/");
  });
}

function untrackedPaths(gitContext) {
  const paths = mux.utils
    .asArray(gitContext.status && gitContext.status.untracked)
    .concat(mux.utils.asArray(gitContext.changedFiles && gitContext.changedFiles.untracked))
    .map(filePath)
    .filter(Boolean);
  return Array.from(new Set(paths));
}

function filePath(value) {
  if (typeof value === "string") return value;
  return value && typeof value.path === "string" ? value.path : "";
}

function normalizedPath(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed === "." || trimmed === "./") return ".";
  return trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
}

function hasOnlyUntrackedChanges(gitContext) {
  return (
    hasUntrackedChanges(gitContext) &&
    !hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.branch) &&
    !hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.staged) &&
    !hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.unstaged) &&
    !hasText(gitContext.diff && gitContext.diff.branch) &&
    !hasText(gitContext.diff && gitContext.diff.staged) &&
    !hasText(gitContext.diff && gitContext.diff.unstaged)
  );
}

function hasUntrackedChanges(gitContext) {
  return (
    hasArrayItems(gitContext.status && gitContext.status.untracked) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.untracked)
  );
}

function hasUncommittedChanges(gitContext) {
  return (
    hasUncommittedStatus(gitContext.status) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.staged) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.unstaged) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.untracked)
  );
}

function hasUncommittedStatus(status) {
  return (
    hasArrayItems(status && status.staged) ||
    hasArrayItems(status && status.unstaged) ||
    hasArrayItems(status && status.untracked)
  );
}

function hasReviewableContext(input, gitContext) {
  if (input.target) return true;
  if (mux.utils.asArray(gitContext.failures).length > 0) return true;
  if (!gitContext.status || gitContext.status.clean !== true) return true;
  return (
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.branch) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.staged) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.unstaged) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.untracked) ||
    hasText(gitContext.diff && gitContext.diff.branch) ||
    hasText(gitContext.diff && gitContext.diff.staged) ||
    hasText(gitContext.diff && gitContext.diff.unstaged)
  );
}

function promptContexts(input, gitContext) {
  const compactedGitContext = compactMetadata(gitContext);
  const reviewDiff = compactDiff(gitContext.diff, REVIEW_DIFF_CHAR_BUDGET);
  const reviewGitContext = { ...compactedGitContext, diff: reviewDiff };
  const outputGitContext = {
    ...compactedGitContext,
    diff: diffSummary(gitContext.diff, reviewDiff),
  };
  return {
    review: renderContext(input, reviewGitContext),
    compact: renderContext(input, outputGitContext),
    outputGitContext: outputGitContext,
  };
}

function renderContext(input, gitContext) {
  return mux.utils.fencedJson({
    input: { target: input.target, fix: input.fix, maxFindings: input.maxFindings },
    gitContextSource: GIT_CONTEXT_SOURCE,
    gitContext: gitContext,
  });
}

function compactMetadata(gitContext) {
  return {
    ...gitContext,
    status: compactStatus(gitContext.status),
    changedFiles: compactChangedFiles(gitContext.changedFiles),
    diffStat: compactDiffStat(gitContext.diffStat),
  };
}

function compactStatus(status) {
  return compactFields(status, STATUS_ARRAY_FIELDS, compactArray, METADATA_ARRAY_ITEM_BUDGET);
}

function compactChangedFiles(changedFiles) {
  return compactFields(
    changedFiles,
    CHANGED_FILE_ARRAY_FIELDS,
    compactArray,
    METADATA_ARRAY_ITEM_BUDGET
  );
}

function compactDiffStat(diffStat) {
  return compactFields(diffStat, DIFF_FIELDS, mux.utils.compactText, DIFF_STAT_CHAR_BUDGET);
}

function compactFields(value, fields, compactor, limit) {
  if (!value || typeof value !== "object") return value;
  const compacted = { ...value };
  fields.forEach(function (field) {
    compacted[field] = compactor(value[field], limit);
  });
  return compacted;
}

function compactArray(value, limit) {
  if (!Array.isArray(value) || value.length <= limit) return value;
  return {
    total: value.length,
    shown: value.slice(0, limit),
    omitted: value.length - limit,
  };
}

function compactDiff(diff, budget) {
  if (!diff || typeof diff !== "object") return diff;

  const compacted = {
    base: diff.base,
    head: diff.head,
    mergeBase: diff.mergeBase,
    truncated: diff.truncated,
    workflowBudgetChars: budget,
    workflowCompactions: [],
  };
  let remaining = budget;

  DIFF_FIELDS.forEach(function (field) {
    const value = diff[field];
    if (typeof value !== "string") {
      compacted[field] = value;
      return;
    }

    const included = Math.max(0, Math.min(value.length, remaining));
    compacted[field] =
      included === value.length ? value : value.slice(0, included) + diffOmittedMessage(field);
    remaining -= included;
    if (included < value.length) {
      compacted.workflowCompactions.push({
        field: field,
        originalChars: value.length,
        includedChars: included,
      });
    }
  });

  return compacted;
}

function diffSummary(diff, compactedDiff) {
  if (!diff || typeof diff !== "object") return diff;
  return {
    base: diff.base,
    head: diff.head,
    mergeBase: diff.mergeBase,
    truncated: diff.truncated,
    workflowBudgetChars: compactedDiff && compactedDiff.workflowBudgetChars,
    workflowCompactions: compactedDiff ? mux.utils.asArray(compactedDiff.workflowCompactions) : [],
    chars: diffFieldLengths(diff),
  };
}

function diffFieldLengths(diff) {
  const lengths = {};
  DIFF_FIELDS.forEach(function (field) {
    lengths[field] = stringLength(diff[field]);
  });
  return lengths;
}

function diffOmittedMessage(field) {
  return (
    "\n\n[Workflow prompt budget omitted the rest of the " +
    field +
    " diff. Inspect the file directly before making claims about omitted hunks.]"
  );
}

function reviewPrompt(lane, input, reviewContext) {
  return [
    READ_ONLY_PROMPT,
    "You are the " + lane.title + " lane. Review every changed file in the supplied Git context.",
    "If an explicit target is provided and the Git diff is empty, inspect that target path in the workspace before making claims.",
    "Diff text is capped by workflowBudgetChars; if workflowCompactions or built-in truncated flags are present, inspect files directly before making claims about omitted hunks.",
    "Untracked paths in Git metadata are names only. Do not make findings about untracked files unless their contents are visible in a diff or explicit target.",
    "Allowed severity values are: high, medium, low. Return high-signal, actionable findings only; an empty findings array is fine.",
    "The synthesis step will keep at most " +
      input.maxFindings +
      " actionable findings. Use stable finding ids and arrays for filePaths/evidence.",
    "Lane checklist:\n- " + lane.instructions.join("\n- "),
    GIT_CONTEXT_PROVENANCE_NOTE,
    "Review context:\n" + reviewContext,
  ].join("\n\n");
}

function synthesisPrompt(input, compactContext, reviewOutputs) {
  return [
    READ_ONLY_PROMPT,
    "Deduplicate and triage these simplify review findings. Keep actionableFindings to the " +
      input.maxFindings +
      " highest-value issues.",
    "Do not edit files in this step. Produce triage and fix plans for the later fixer step. If a finding is false positive or not worth addressing, put it in skippedFindings without debating it.",
    "Allowed severity values are: high, medium, low. Prefer minimal cleanup over broad refactors.",
    GIT_CONTEXT_PROVENANCE_NOTE,
    "Compact review context without raw diff text:\n" + compactContext,
    "Compacted lane outputs:\n" + mux.utils.fencedJson(compactReviewOutputs(reviewOutputs)),
  ].join("\n\n");
}

function fixPrompt(compactContext, synthesized) {
  return [
    "Fix the actionable simplify findings with minimal, correct, reviewable changes. Do not push or open a PR.",
    "If you change files, create one local commit containing only those changes so the workflow can export a patch artifact.",
    "Use the compact context for file lists and diff metadata; inspect files directly instead of relying on raw diff text being embedded in this prompt.",
    "Preserve existing style and functionality. Run targeted validation for touched code when feasible and report exact commands/results.",
    "If a finding is false positive or not worth addressing, skip it and note why. Set madeChanges true only when files changed.",
    GIT_CONTEXT_PROVENANCE_NOTE,
    "Compact review context:\n" + compactContext,
    "Actionable findings:\n" + mux.utils.fencedJson(fixerPayload(synthesized)),
  ].join("\n\n");
}

function compactReviewOutputs(reviewOutputs) {
  return reviewOutputs.map(function (output) {
    return {
      summary: output.summary,
      findings: output.findings.map(compactReviewFinding),
    };
  });
}

function compactReviewFinding(finding) {
  const evidence = finding.evidence;
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    filePaths: finding.filePaths,
    rationale: finding.rationale,
    recommendation: finding.recommendation,
    evidenceCount: evidence.length,
    evidenceSamples: evidence.slice(0, REVIEW_EVIDENCE_ITEM_BUDGET).map(function (evidenceItem) {
      return mux.utils.compactText(evidenceItem, REVIEW_EVIDENCE_CHAR_BUDGET);
    }),
  };
}

function fixerPayload(synthesized) {
  return {
    summary: synthesized.summary,
    shouldFix: synthesized.shouldFix,
    actionableFindings: synthesized.actionableFindings,
    validationPlan: synthesized.validationPlan,
  };
}

function parseArgs(args) {
  const raw = args && typeof args === "object" ? args : {};
  const input = {
    help: Boolean(raw.help),
    fix: raw.fix !== false && raw.reviewOnly !== true,
    target: text(raw.target),
    baseRef: text(raw.baseRef || raw.base),
    trunkRef: text(raw.trunkRef || raw.trunk),
    headRef: text(raw.headRef || raw.head),
    maxFindings: mux.utils.boundedInt(
      raw.maxFindings,
      DEFAULT_MAX_FINDINGS,
      1,
      Number.MAX_SAFE_INTEGER
    ),
  };
  const tokenized = tokenize(String(raw.input || ""));
  if (tokenized.error) return { input: input, error: tokenized.error };

  const targetParts = [];
  let index = 0;
  while (index < tokenized.tokens.length) {
    const token = tokenized.tokens[index];
    const valueFlag = parseValueFlag(tokenized.tokens, index);
    if (token === "--help" || token === "-h") input.help = true;
    else if (token === "--review-only" || token === "--no-fix") input.fix = false;
    else if (token === "--fix") input.fix = true;
    else if (valueFlag && valueFlag.error) return { input: input, error: valueFlag.error };
    else if (valueFlag) {
      input[valueFlag.key] =
        valueFlag.key === "maxFindings"
          ? mux.utils.boundedInt(valueFlag.value, DEFAULT_MAX_FINDINGS, 1, Number.MAX_SAFE_INTEGER)
          : valueFlag.value;
      index = valueFlag.nextIndex;
      continue;
    } else targetParts.push(token);
    index += 1;
  }

  if (!input.target) input.target = targetParts.join(" ").trim();
  return { input: input, error: "" };
}

function parseValueFlag(tokens, index) {
  const token = tokens[index];
  for (let flagIndex = 0; flagIndex < VALUE_FLAGS.length; flagIndex += 1) {
    const flag = VALUE_FLAGS[flagIndex];
    if (token === flag.name) {
      if (index + 1 >= tokens.length) return { error: flag.name + " requires a value" };
      return { key: flag.key, value: tokens[index + 1], nextIndex: index + 2 };
    }
    if (token.startsWith(flag.name + "=")) {
      const value = token.slice(flag.name.length + 1);
      if (!value) return { error: flag.name + " requires a value" };
      return { key: flag.key, value: value, nextIndex: index + 1 };
    }
  }
  return null;
}

function tokenize(input) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      current += char;
      escaped = false;
    } else if (quote && char === "\\") {
      const next = input[index + 1];
      if (next === "\\" || (next === quote && !isClosingQuote(input, index + 1))) {
        escaped = true;
      } else current += char;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else current += char;
  }
  if (quote) return { tokens: tokens, error: "unterminated quoted argument" };
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return { tokens: tokens, error: "" };
}

function isClosingQuote(input, quoteIndex) {
  return quoteIndex + 1 >= input.length || /\s/.test(input[quoteIndex + 1]);
}

function reviewOnlyReport(input, markdown) {
  const mode = input.fix
    ? "No actionable fixes were selected."
    : "Review-only mode; no fixes were applied.";
  return markdown + "\n\n---\n\n## Simplify workflow result\n\n" + mode;
}

function fixReport(synthesisMarkdown, fixerMarkdown, applied) {
  const status = applied && applied.status ? applied.status : "unknown";
  const success = Boolean(applied && applied.success);
  return (
    synthesisMarkdown +
    "\n\n---\n\n## Fix pass\n\n" +
    fixerMarkdown +
    "\n\n### Patch application\n\n- Status: " +
    status +
    "\n- Success: " +
    String(success)
  );
}

function usageResult(error) {
  const lines = [
    "# simplify workflow",
    "",
    "Review current git changes for code reuse, quality, efficiency, and polish, then fix actionable issues.",
    "",
    "## Usage",
    "",
    "- `/workflow simplify` — review current git changes and apply fixes.",
    "- `/workflow simplify --review-only` — review and synthesize findings without applying fixes.",
    "- `/workflow simplify --base main --head HEAD` — review a specific ref range.",
    "- `/workflow simplify path/or/context` — provide an explicit target when there are no Git changes.",
    "",
    "## Options",
    "",
    "- `--review-only` / `--no-fix`",
    "- `--fix`",
    "- `--base <ref>`",
    "- `--trunk <ref>`",
    "- `--head <ref>`",
    "- `--max-findings <n>`",
  ];
  if (error) lines.splice(2, 0, "", "**Argument error:** " + error);
  return {
    reportMarkdown: lines.join("\n"),
    structuredOutput: { help: true, error: error || "" },
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasArrayItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasText(value) {
  return stringLength(value) > 0;
}

function stringLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function formatError(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
