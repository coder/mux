// description: Review current changes for reuse, quality, and efficiency, then fix actionable issues.

const DEFAULT_MAX_FINDINGS = 20;
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
const FINDING_SCHEMA = {
  type: "object",
  required: ["id", "title", "severity", "filePaths", "rationale", "recommendation", "evidence"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    severity: SEVERITY_SCHEMA,
    filePaths: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
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
    id: { type: "string" },
    title: { type: "string" },
    severity: SEVERITY_SCHEMA,
    filePaths: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
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

export default function simplifyWorkflow({ args, phase, log, action, parallelAgents, agent, applyPatch }) {
  assert(action && parallelAgents && agent && applyPatch, "workflow runtime APIs are required");

  const input = parseArgs(args);
  if (input.help) return usageResult();

  phase("capture-context", { target: input.target || "current git changes", fix: input.fix });
  const gitContext = collectGitContext(action, input);
  log("Captured simplify context", {
    target: input.target || "current git changes",
    gitFailures: gitContext.failures.length,
  });

  const reviewContext = renderReviewContext(input, gitContext);

  phase("review", { lanes: REVIEW_LANES.map(function (lane) { return lane.id; }) });
  const reviewOutputs = parallelAgents(
    REVIEW_LANES.map(function (lane) {
      return {
        id: lane.id + "-review",
        title: lane.title,
        agentId: REVIEW_AGENT_ID,
        prompt: reviewPrompt(lane, input, reviewContext),
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
    prompt: synthesisPrompt(input, reviewContext, reviewOutputs),
    outputSchema: SYNTHESIS_SCHEMA,
  });
  const synthesized = mustObject(synthesis.structuredOutput, "synthesis structured output is required");
  const actionableFindings = asArray(synthesized.actionableFindings);

  if (!input.fix || !synthesized.shouldFix || actionableFindings.length === 0) {
    return {
      reportMarkdown: reviewOnlyReport(input, synthesis.reportMarkdown),
      structuredOutput: {
        mode: input.fix ? "no-actionable-fixes" : "review-only",
        gitContext: gitContext,
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
    prompt: fixPrompt(reviewContext, synthesized),
    outputSchema: FIXER_SCHEMA,
  });
  const fixerOutput = mustObject(fixer.structuredOutput, "fixer structured output is required");

  if (!fixerOutput.madeChanges) {
    return {
      reportMarkdown: synthesis.reportMarkdown + "\n\n---\n\n## Fix pass\n\nThe fixer did not make file changes.\n\n" + fixer.reportMarkdown,
      structuredOutput: {
        mode: "fixer-made-no-changes",
        gitContext: gitContext,
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
      gitContext: gitContext,
      reviews: reviewOutputs,
      synthesis: synthesized,
      fix: { fixer: fixerOutput, applied: applied },
    },
  };
}

function collectGitContext(action, input) {
  const refs = gitRefs(input);
  const failures = [];
  return {
    target: input.target,
    refs: refs,
    failures: failures,
    status: gitSlice(failures, "status", function () {
      return action.git.status({ id: "git-status", input: { includeIgnored: false }, builtInOnly: true }).output;
    }),
    changedFiles: gitSlice(failures, "changedFiles", function () {
      return action.git.changedFiles({ id: "git-changed-files", input: refs, builtInOnly: true }).output;
    }),
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

function renderReviewContext(input, gitContext) {
  return fencedJson({
    input: {
      target: input.target,
      fix: input.fix,
      baseRef: input.baseRef,
      trunkRef: input.trunkRef,
      headRef: input.headRef,
      maxFindings: input.maxFindings,
    },
    gitContext: gitContext,
  });
}

function reviewPrompt(lane, input, reviewContext) {
  return [
    readOnlyPrompt(),
    "You are the " + lane.title + " lane. Review every changed file in the supplied Git context.",
    "If an explicit target is provided and the Git diff is empty, inspect that target path in the workspace before making claims.",
    "Allowed severity values are: high, medium, low. Return high-signal, actionable findings only; an empty findings array is fine.",
    "The synthesis step will keep at most " + input.maxFindings + " actionable findings. Use stable finding ids and arrays for filePaths/evidence.",
    "\nLane checklist:\n- " + lane.instructions.join("\n- "),
    "\nReview context:\n" + reviewContext,
  ].join("\n\n");
}

function synthesisPrompt(input, reviewContext, reviewOutputs) {
  return [
    readOnlyPrompt(),
    "Deduplicate and triage these simplify review findings. Keep actionableFindings to the " + input.maxFindings + " highest-value issues.",
    "Fix actionable issues directly when fix mode is enabled. If a finding is false positive or not worth addressing, put it in skippedFindings without debating it.",
    "Allowed severity values are: high, medium, low. Prefer minimal cleanup over broad refactors.",
    "\nOriginal review context:\n" + reviewContext,
    "\nLane outputs:\n" + fencedJson(reviewOutputs),
  ].join("\n\n");
}

function fixPrompt(reviewContext, synthesized) {
  return [
    "Fix the actionable simplify findings with minimal, correct, reviewable changes. Do not push, commit, or open a PR.",
    "Preserve existing style and functionality. Run targeted validation for touched code when feasible and report exact commands/results.",
    "If a finding is false positive or not worth addressing, skip it and note why. Set madeChanges true only when files changed.",
    "\nOriginal review context:\n" + reviewContext,
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
  const targetParts = [];
  const tokens = tokenize(String(raw.input || ""));

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const valueFlag = parseValueFlag(tokens, index);
    if (token === "--help" || token === "-h") input.help = true;
    else if (token === "--review-only" || token === "--no-fix") input.fix = false;
    else if (token === "--fix") input.fix = true;
    else if (valueFlag) {
      input[valueFlag.key] = valueFlag.key === "maxFindings" ? positiveInt(valueFlag.value, DEFAULT_MAX_FINDINGS) : valueFlag.value;
      index = valueFlag.index;
    } else targetParts.push(token);
  }

  if (!input.target) input.target = targetParts.join(" ").trim();
  return input;
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
      assert(index + 1 < tokens.length, flag.name + " requires a value");
      return { key: flag.key, value: tokens[index + 1], index: index + 1 };
    }
    if (token.indexOf(flag.name + "=") === 0) {
      return { key: flag.key, value: token.slice(flag.name.length + 1), index: index };
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
  assert(!quote, "unterminated quoted argument");
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function readOnlyPrompt() {
  return "This is a read-only review step. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report findings.";
}

function reviewOnlyReport(input, markdown) {
  const mode = input.fix ? "No actionable fixes were selected." : "Review-only mode; no fixes were applied.";
  return markdown + "\n\n---\n\n## Simplify workflow result\n\n" + mode;
}

function fixReport(synthesisMarkdown, fixerMarkdown, applied) {
  const status = applied && applied.status ? applied.status : "unknown";
  const success = Boolean(applied && applied.success);
  return synthesisMarkdown + "\n\n---\n\n## Fix pass\n\n" + fixerMarkdown + "\n\n### Patch application\n\n- Status: " + status + "\n- Success: " + String(success);
}

function usageResult() {
  return {
    reportMarkdown: [
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
    ].join("\n"),
    structuredOutput: { help: true },
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

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
