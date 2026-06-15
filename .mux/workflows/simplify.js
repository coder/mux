// description: Review current changes for reuse, quality, and efficiency, then fix actionable issues.

const DEFAULT_MAX_FINDINGS = 20;
// Review agents get bounded diff text; synthesis/fix phases get metadata only.
const REVIEW_DIFF_CHAR_BUDGET = 60000;
const METADATA_ARRAY_ITEM_BUDGET = 200;
const DIFF_STAT_CHAR_BUDGET = 20000;
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
];

const SEVERITY_SCHEMA = { type: "string", enum: ["high", "medium", "low"] };
const FINDING_CORE_PROPERTIES = {
  id: { type: "string" },
  title: { type: "string" },
  severity: SEVERITY_SCHEMA,
  filePaths: { type: "array", items: { type: "string" } },
  rationale: { type: "string" },
};
const FINDING_SCHEMA = {
  type: "object",
  required: ["id", "title", "severity", "filePaths", "rationale", "recommendation", "evidence"],
  properties: {
    ...FINDING_CORE_PROPERTIES,
    recommendation: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
  },
};
const REVIEW_SCHEMA = {
  type: "object",
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: FINDING_SCHEMA },
  },
};
const SYNTHESIS_FINDING_SCHEMA = {
  type: "object",
  required: ["id", "title", "severity", "filePaths", "rationale", "fixPlan"],
  properties: {
    ...FINDING_CORE_PROPERTIES,
    fixPlan: { type: "string" },
  },
};
const SKIPPED_FINDING_SCHEMA = {
  type: "object",
  required: ["id", "title", "reason"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    reason: { type: "string" },
  },
};
const SYNTHESIS_SCHEMA = {
  type: "object",
  required: ["summary", "shouldFix", "actionableFindings", "skippedFindings", "validationPlan"],
  properties: {
    summary: { type: "string" },
    shouldFix: { type: "boolean" },
    actionableFindings: { type: "array", items: SYNTHESIS_FINDING_SCHEMA },
    skippedFindings: { type: "array", items: SKIPPED_FINDING_SCHEMA },
    validationPlan: { type: "array", items: { type: "string" } },
  },
};
const FIXER_SCHEMA = {
  type: "object",
  required: ["madeChanges", "fixedFindingIds", "skippedFindings", "validation"],
  properties: {
    madeChanges: { type: "boolean" },
    fixedFindingIds: { type: "array", items: { type: "string" } },
    skippedFindings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "reason"],
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    validation: {
      type: "array",
      items: {
        type: "object",
        required: ["command", "status", "summary"],
        properties: {
          command: { type: "string" },
          status: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
  },
};

export default function simplifyWorkflow({
  args,
  phase,
  log,
  action,
  parallelAgents,
  agent,
  applyPatch,
}) {
  assert(action && parallelAgents && agent && applyPatch, "workflow runtime APIs are required");

  const parsed = parseArgs(args);
  if (parsed.error) return usageResult(parsed.error);

  const input = parsed.input;
  if (input.help) return usageResult();

  phase("capture-context", { target: input.target || "current git changes", fix: input.fix });
  const gitContext = collectGitContext(action, input);
  const contexts = promptContexts(input, gitContext);
  log("Captured simplify context", {
    target: input.target || "current git changes",
    gitFailures: gitContext.failures.length,
    diffCompactions: diffCompactions(contexts.outputGitContext).length,
  });

  if (!hasReviewableContext(input, gitContext)) {
    return {
      reportMarkdown: "## Simplify workflow result\n\nNo reviewable changes found.",
      structuredOutput: {
        mode: "no-reviewable-changes",
        gitContext: contexts.outputGitContext,
        reviews: [],
        synthesis: emptySynthesis("No reviewable changes found."),
      },
    };
  }

  phase("review", {
    lanes: REVIEW_LANES.map(function (lane) {
      return lane.id;
    }),
  });
  const reviewOutputs = parallelAgents(
    REVIEW_LANES.map(function (lane) {
      return {
        id: lane.id + "-review",
        title: lane.title,
        agentId: REVIEW_AGENT_ID,
        prompt: reviewPrompt(lane, input, contexts.review),
        outputSchema: REVIEW_SCHEMA,
      };
    }),
    { maxParallel: REVIEW_LANES.length }
  ).map(function (review) {
    return mustObject(review.structuredOutput, "review structured output is required");
  });

  const rawFindingCount = reviewOutputs.reduce(function (count, output) {
    return count + asArray(output.findings).length;
  }, 0);

  phase("synthesize", { rawFindingCount: rawFindingCount });
  const synthesis = agent({
    id: "synthesize-simplify-findings",
    title: "Simplify: synthesize findings",
    agentId: EXEC_AGENT_ID,
    prompt: synthesisPrompt(input, contexts.compact, reviewOutputs),
    outputSchema: SYNTHESIS_SCHEMA,
  });
  const synthesized = mustObject(
    synthesis.structuredOutput,
    "synthesis structured output is required"
  );
  const actionableFindings = asArray(synthesized.actionableFindings);

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

  phase("fix", { actionableFindingCount: actionableFindings.length });
  const fixer = agent({
    id: "fix-simplify-findings",
    title: "Simplify: fix actionable findings",
    agentId: EXEC_AGENT_ID,
    prompt: fixPrompt(contexts.compact, synthesized),
    outputSchema: FIXER_SCHEMA,
  });
  const fixerOutput = mustObject(fixer.structuredOutput, "fixer structured output is required");

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
  const applied = applyPatch({
    id: "apply-simplify-fixes",
    source: fixer,
    target: "parent",
    threeWay: true,
    onConflict: "return",
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

function collectGitContext(action, input) {
  const requestedRefs = gitRefs(input);
  const failures = [];
  const status = gitSlice(failures, "status", function () {
    return action.git.status({
      id: "git-status",
      input: { includeIgnored: false },
      builtInOnly: true,
    }).output;
  });
  const changedFiles = gitSlice(failures, "changedFiles", function () {
    return action.git.changedFiles({
      id: "git-changed-files",
      input: requestedRefs,
      builtInOnly: true,
    }).output;
  });
  const refs = refsWithResolvedBase(requestedRefs, changedFiles);

  return {
    target: input.target,
    refs: refs,
    failures: failures,
    status: status,
    changedFiles: changedFiles,
    diffStat: gitSlice(failures, "diffStat", function () {
      return action.git.diffStat({ id: "git-diff-stat", input: refs, builtInOnly: true }).output;
    }),
    diff: gitSlice(failures, "diff", function () {
      return action.git.diff({ id: "git-diff", input: refs, builtInOnly: true }).output;
    }),
  };
}

function gitSlice(failures, name, read) {
  try {
    return read();
  } catch (error) {
    failures.push({ name: name, error: String(error) });
    return null;
  }
}

function gitRefs(input) {
  const refs = {};
  if (input.baseRef) refs.base = input.baseRef;
  if (input.trunkRef) refs.trunk = input.trunkRef;
  if (input.headRef) refs.head = input.headRef;
  return refs;
}

function refsWithResolvedBase(refs, changedFiles) {
  if (refs.base || refs.trunk || !changedFiles || typeof changedFiles.base !== "string") {
    return refs;
  }
  if (!changedFiles.base) return refs;

  const resolved = { base: changedFiles.base };
  if (refs.head) resolved.head = refs.head;
  return resolved;
}

function hasReviewableContext(input, gitContext) {
  if (input.target) return true;
  if (asArray(gitContext.failures).length > 0) return true;
  if (!gitContext.status || gitContext.status.clean !== true) return true;
  return (
    hasArrayItems(gitContext.status.staged) ||
    hasArrayItems(gitContext.status.unstaged) ||
    hasArrayItems(gitContext.status.untracked) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.branch) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.staged) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.unstaged) ||
    hasArrayItems(gitContext.changedFiles && gitContext.changedFiles.untracked) ||
    hasText(gitContext.diff && gitContext.diff.branch) ||
    hasText(gitContext.diff && gitContext.diff.staged) ||
    hasText(gitContext.diff && gitContext.diff.unstaged)
  );
}

function emptySynthesis(summary) {
  return {
    summary: summary,
    shouldFix: false,
    actionableFindings: [],
    skippedFindings: [],
    validationPlan: [],
  };
}

function promptContexts(input, gitContext) {
  const reviewGitContext = compactMetadata(withCompactedDiff(gitContext, REVIEW_DIFF_CHAR_BUDGET));
  const outputGitContext = compactMetadata(withoutDiffText(gitContext, reviewGitContext.diff));
  return {
    review: renderContext(input, reviewGitContext),
    compact: renderContext(input, outputGitContext),
    outputGitContext: outputGitContext,
  };
}

function renderContext(input, gitContext) {
  return fencedJson({
    input: { target: input.target, fix: input.fix, maxFindings: input.maxFindings },
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
  if (!status || typeof status !== "object") return status;
  return {
    ...status,
    staged: compactArray(status.staged, METADATA_ARRAY_ITEM_BUDGET),
    unstaged: compactArray(status.unstaged, METADATA_ARRAY_ITEM_BUDGET),
    untracked: compactArray(status.untracked, METADATA_ARRAY_ITEM_BUDGET),
    ignored: compactArray(status.ignored, METADATA_ARRAY_ITEM_BUDGET),
  };
}

function compactChangedFiles(changedFiles) {
  if (!changedFiles || typeof changedFiles !== "object") return changedFiles;
  return {
    ...changedFiles,
    branch: compactArray(changedFiles.branch, METADATA_ARRAY_ITEM_BUDGET),
    staged: compactArray(changedFiles.staged, METADATA_ARRAY_ITEM_BUDGET),
    unstaged: compactArray(changedFiles.unstaged, METADATA_ARRAY_ITEM_BUDGET),
    untracked: compactArray(changedFiles.untracked, METADATA_ARRAY_ITEM_BUDGET),
  };
}

function compactDiffStat(diffStat) {
  if (!diffStat || typeof diffStat !== "object") return diffStat;
  return {
    ...diffStat,
    branch: compactText(diffStat.branch, DIFF_STAT_CHAR_BUDGET),
    staged: compactText(diffStat.staged, DIFF_STAT_CHAR_BUDGET),
    unstaged: compactText(diffStat.unstaged, DIFF_STAT_CHAR_BUDGET),
  };
}

function compactArray(value, limit) {
  if (!Array.isArray(value) || value.length <= limit) return value;
  return {
    total: value.length,
    shown: value.slice(0, limit),
    omitted: value.length - limit,
  };
}

function compactText(value, limit) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return (
    value.slice(0, limit) +
    "\n\n[Workflow metadata budget omitted " +
    (value.length - limit) +
    " chars.]"
  );
}

function withCompactedDiff(gitContext, budget) {
  return { ...gitContext, diff: compactDiff(gitContext.diff, budget) };
}

function withoutDiffText(gitContext, compactedDiff) {
  return { ...gitContext, diff: diffSummary(gitContext.diff, compactedDiff) };
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

  ["branch", "staged", "unstaged"].forEach(function (field) {
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
    workflowCompactions: compactedDiff ? asArray(compactedDiff.workflowCompactions) : [],
    chars: {
      branch: stringLength(diff.branch),
      staged: stringLength(diff.staged),
      unstaged: stringLength(diff.unstaged),
    },
  };
}

function diffCompactions(gitContext) {
  return asArray(gitContext && gitContext.diff && gitContext.diff.workflowCompactions);
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
    readOnlyPrompt(),
    "You are the " + lane.title + " lane. Review every changed file in the supplied Git context.",
    "If an explicit target is provided and the Git diff is empty, inspect that target path in the workspace before making claims.",
    "Diff text is capped by workflowBudgetChars; if workflowCompactions or built-in truncated flags are present, inspect files directly before making claims about omitted hunks.",
    "Allowed severity values are: high, medium, low. Return high-signal, actionable findings only; an empty findings array is fine.",
    "The synthesis step will keep at most " +
      input.maxFindings +
      " actionable findings. Use stable finding ids and arrays for filePaths/evidence.",
    "\nLane checklist:\n- " + lane.instructions.join("\n- "),
    "\nReview context:\n" + reviewContext,
  ].join("\n\n");
}

function synthesisPrompt(input, compactContext, reviewOutputs) {
  return [
    readOnlyPrompt(),
    "Deduplicate and triage these simplify review findings. Keep actionableFindings to the " +
      input.maxFindings +
      " highest-value issues.",
    "Fix actionable issues directly when fix mode is enabled. If a finding is false positive or not worth addressing, put it in skippedFindings without debating it.",
    "Allowed severity values are: high, medium, low. Prefer minimal cleanup over broad refactors.",
    "\nCompact review context without raw diff text:\n" + compactContext,
    "\nLane outputs:\n" + fencedJson(reviewOutputs),
  ].join("\n\n");
}

function fixPrompt(compactContext, synthesized) {
  return [
    "Fix the actionable simplify findings with minimal, correct, reviewable changes. Do not push, commit, or open a PR.",
    "Use the compact context for file lists and diff metadata; inspect files directly instead of relying on raw diff text being embedded in this prompt.",
    "Preserve existing style and functionality. Run targeted validation for touched code when feasible and report exact commands/results.",
    "If a finding is false positive or not worth addressing, skip it and note why. Set madeChanges true only when files changed.",
    "\nCompact review context:\n" + compactContext,
    "\nSynthesized findings:\n" + fencedJson(synthesized),
  ].join("\n\n");
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
    maxFindings: positiveInt(raw.maxFindings, DEFAULT_MAX_FINDINGS),
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
          ? positiveInt(valueFlag.value, DEFAULT_MAX_FINDINGS)
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
  const flags = [
    { name: "--base", key: "baseRef" },
    { name: "--trunk", key: "trunkRef" },
    { name: "--head", key: "headRef" },
    { name: "--max-findings", key: "maxFindings" },
  ];
  const token = tokens[index];
  for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
    const flag = flags[flagIndex];
    if (token === flag.name) {
      if (index + 1 >= tokens.length) return { error: flag.name + " requires a value" };
      return { key: flag.key, value: tokens[index + 1], nextIndex: index + 2 };
    }
    if (token.indexOf(flag.name + "=") === 0) {
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
      escaped = true;
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

function readOnlyPrompt() {
  return "This is a read-only review step. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report findings.";
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
    "Review current git changes for code reuse, quality, and efficiency, then fix actionable issues.",
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

function fencedJson(value) {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function mustObject(value, message) {
  assert(value && typeof value === "object", message);
  return value;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasArrayItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasText(value) {
  return typeof value === "string" && value.length > 0;
}

function stringLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
