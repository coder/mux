import { homedir } from "os";

import assert from "@/common/utils/assert";
import { BASH_HARD_MAX_LINES, BASH_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";
import { SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS } from "@/common/types/tasks";

export type BashOutputIntent = "exploration" | "logs" | "unknown";

export function isBashOutputAlreadyTargeted(script: string): boolean {
  assert(typeof script === "string", "script must be a string");

  const trimmed = script.trim();
  if (trimmed.length === 0) {
    return false;
  }

  // If the script already limits output to a slice (head/tail/line ranges), further denoising is
  // likely to drop exactly what the caller asked to see.
  //
  // NOTE: Avoid false positives like `git rev-parse HEAD`.
  const statementSegments = trimmed
    .split(/(?:\r?\n|&&|;)+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const slicingCommands = new Set(["head", "tail"]);
  for (const statement of statementSegments) {
    const pipeSegments = statement
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);

    for (const pipeSegment of pipeSegments) {
      const tokens = pipeSegment.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        continue;
      }

      const cmd0 = (tokens[0] ?? "").toLowerCase();
      const cmd1 = (tokens[1] ?? "").toLowerCase();

      if (slicingCommands.has(cmd0)) {
        return true;
      }

      // Common wrapper: `sudo head ...`.
      if ((cmd0 === "sudo" || cmd0 === "command") && slicingCommands.has(cmd1)) {
        return true;
      }
    }
  }

  if (/\bsed\b[^\n]*\s-n\s+['"]?\d+\s*,\s*\d+\s*p['"]?/i.test(trimmed)) {
    return true;
  }

  if (/\bawk\b[^\n]*\bNR\s*(==|!=|>=|<=|>|<)\s*\d+/i.test(trimmed)) {
    return true;
  }

  return false;
}

function normalizeDisplayName(displayName: string | undefined): string | undefined {
  if (typeof displayName !== "string") {
    return undefined;
  }

  const trimmed = displayName.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getFirstNonTrivialCommand(script: string): { cmd: string; args: string[] } | undefined {
  const segments = script
    .split(/(?:\r?\n|&&|;)+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const ignoredCommands = new Set(["cd", "pushd", "popd", "export", "set"]);

  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }

    const rawCmd = tokens[0] ?? "";
    const cmd = rawCmd.replace(/^\\/, "");

    if (!cmd || ignoredCommands.has(cmd)) {
      continue;
    }

    return { cmd, args: tokens.slice(1) };
  }

  return undefined;
}

export function classifyBashIntent(params: {
  script: string;
  displayName?: string;
}): BashOutputIntent {
  assert(params, "params is required");
  assert(typeof params.script === "string", "script must be a string");

  const displayName = normalizeDisplayName(params.displayName);
  if (displayName) {
    const normalized = displayName.toLowerCase();
    if (/\b(list|explore|search|scan)\b/.test(normalized)) {
      return "exploration";
    }
  }

  const first = getFirstNonTrivialCommand(params.script);
  if (first) {
    const cmd = first.cmd.toLowerCase();
    const arg0 = first.args[0]?.toLowerCase();

    const explorationCommands = new Set(["ls", "find", "fd", "tree", "rg", "grep"]);
    if (explorationCommands.has(cmd)) {
      return "exploration";
    }

    if (cmd === "git" && (arg0 === "ls-files" || arg0 === "status")) {
      return "exploration";
    }

    const logCommands = new Set(["make", "bun", "npm", "yarn", "pnpm"]);
    if (logCommands.has(cmd)) {
      return "logs";
    }
  }

  return "unknown";
}

function isGitConflictMarkerSearch(script: string): boolean {
  assert(typeof script === "string", "script must be a string");

  const trimmed = script.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const literalNeedles = ["<<<<<<<", ">>>>>>>", "=======", "|||||||"];
  for (const needle of literalNeedles) {
    if (trimmed.includes(needle)) {
      return true;
    }
  }

  // Common regex quantifier forms (used in `rg`/`grep` patterns).
  const quantifierNeedles = ["<{7}", ">{7}", "={7}", "|{7}"];
  for (const needle of quantifierNeedles) {
    if (trimmed.includes(needle)) {
      return true;
    }
  }

  return false;
}

function scriptMentionsPlanFile(script: string, planFilePath: string | undefined): boolean {
  assert(typeof script === "string", "script must be a string");

  if (typeof planFilePath !== "string") {
    return false;
  }

  const trimmedPlanFilePath = planFilePath.trim();
  if (trimmedPlanFilePath.length === 0) {
    return false;
  }

  const needles = new Set<string>();

  const addNeedle = (needle: string): void => {
    const trimmed = needle.trim();
    if (trimmed.length === 0) {
      return;
    }

    needles.add(trimmed);
  };

  const addNeedleVariants = (needle: string): void => {
    addNeedle(needle);
    addNeedle(needle.replaceAll("\\\\", "/"));
  };

  addNeedleVariants(trimmedPlanFilePath);

  const home = homedir();
  const homePosix = home.replaceAll("\\\\", "/");

  if (trimmedPlanFilePath === "~") {
    addNeedleVariants(home);
    addNeedleVariants(homePosix);
  } else if (trimmedPlanFilePath.startsWith("~/") || trimmedPlanFilePath.startsWith("~\\\\")) {
    const suffix = trimmedPlanFilePath.slice(1);
    addNeedleVariants(`${home}${suffix}`);
    addNeedleVariants(`${homePosix}${suffix.replaceAll("\\\\", "/")}`);
  }

  // Also match the `~` form when the configured plan path is already expanded.
  for (const candidateHome of [home, homePosix]) {
    if (!trimmedPlanFilePath.startsWith(candidateHome)) {
      continue;
    }

    const suffix = trimmedPlanFilePath.slice(candidateHome.length);
    if (suffix.length > 0 && !suffix.startsWith("/") && !suffix.startsWith("\\\\")) {
      continue;
    }

    addNeedleVariants(`~${suffix}`);
  }

  for (const needle of needles) {
    if (script.includes(needle)) {
      return true;
    }
  }

  return false;
}

export type BashOutputCompactionSkipReason =
  | "below_threshold"
  | "already_targeted_script"
  | "plan_file_in_script"
  | "exploration_output_small"
  | "conflict_marker_search_within_limits";

export interface BashOutputCompactionDecision {
  shouldCompact: boolean;
  skipReason?: BashOutputCompactionSkipReason;

  triggeredByLines: boolean;
  triggeredByBytes: boolean;

  alreadyTargeted: boolean;
  intent: BashOutputIntent;

  effectiveMaxKeptLines: number;
}

const EXPLORATION_SKIP_MAX_LINES = 120;
const EXPLORATION_SKIP_MAX_BYTES = 12 * 1024;
const EXPLORATION_BOOST_MAX_KEPT_LINES = 120;

export function decideBashOutputCompaction(params: {
  toolName: string;
  script: string;
  displayName?: string;
  planFilePath?: string;

  totalLines: number;
  totalBytes: number;

  minLines: number;
  minTotalBytes: number;
  maxKeptLines: number;
}): BashOutputCompactionDecision {
  assert(params, "params is required");
  assert(
    typeof params.toolName === "string" && params.toolName.length > 0,
    "toolName must be a non-empty string"
  );
  assert(typeof params.script === "string", "script must be a string");
  assert(
    typeof params.planFilePath === "string" || typeof params.planFilePath === "undefined",
    "planFilePath must be a string if provided"
  );
  assert(
    Number.isInteger(params.totalLines) && params.totalLines >= 0,
    "totalLines must be a non-negative integer"
  );
  assert(
    Number.isInteger(params.totalBytes) && params.totalBytes >= 0,
    "totalBytes must be a non-negative integer"
  );
  assert(Number.isInteger(params.minLines) && params.minLines >= 0, "minLines must be >= 0");
  assert(
    Number.isInteger(params.minTotalBytes) && params.minTotalBytes >= 0,
    "minTotalBytes must be >= 0"
  );
  assert(
    Number.isInteger(params.maxKeptLines) && params.maxKeptLines > 0,
    "maxKeptLines must be a positive integer"
  );

  const triggeredByLines = params.totalLines > params.minLines;
  const triggeredByBytes = params.totalBytes > params.minTotalBytes;

  let intent: BashOutputIntent = "unknown";
  let alreadyTargeted = false;
  let effectiveMaxKeptLines = params.maxKeptLines;

  if (!triggeredByLines && !triggeredByBytes) {
    return {
      shouldCompact: false,
      skipReason: "below_threshold",
      triggeredByLines,
      triggeredByBytes,
      alreadyTargeted,
      intent,
      effectiveMaxKeptLines,
    };
  }

  if (params.toolName === "bash") {
    alreadyTargeted = isBashOutputAlreadyTargeted(params.script);
    intent = classifyBashIntent({ script: params.script, displayName: params.displayName });

    if (scriptMentionsPlanFile(params.script, params.planFilePath)) {
      // Plan Mode invariant: the plan file is the source of truth. System1 compaction can drop
      // the middle of the document, forcing extra tool calls and/or leading to incorrect plans.
      return {
        shouldCompact: false,
        skipReason: "plan_file_in_script",
        triggeredByLines,
        triggeredByBytes,
        alreadyTargeted,
        intent,
        effectiveMaxKeptLines,
      };
    }

    if (alreadyTargeted) {
      return {
        shouldCompact: false,
        skipReason: "already_targeted_script",
        triggeredByLines,
        triggeredByBytes,
        alreadyTargeted,
        intent,
        effectiveMaxKeptLines,
      };
    }

    const defaultMinLines =
      SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.default;
    const defaultMinTotalBytes =
      SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.default;
    const defaultMaxKeptLines =
      SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.default;

    // If a user has customized compaction settings, respect those limits even for exploration output.
    const isDefaultCompactionConfig =
      params.minLines === defaultMinLines &&
      params.minTotalBytes === defaultMinTotalBytes &&
      params.maxKeptLines === defaultMaxKeptLines;

    const isConflictMarkerSearch = isGitConflictMarkerSearch(params.script);

    if (
      isDefaultCompactionConfig &&
      isConflictMarkerSearch &&
      params.totalLines <= BASH_HARD_MAX_LINES &&
      params.totalBytes <= BASH_MAX_TOTAL_BYTES
    ) {
      return {
        shouldCompact: false,
        skipReason: "conflict_marker_search_within_limits",
        triggeredByLines,
        triggeredByBytes,
        alreadyTargeted,
        intent,
        effectiveMaxKeptLines,
      };
    }

    if (
      intent === "exploration" &&
      params.totalLines <= EXPLORATION_SKIP_MAX_LINES &&
      params.totalBytes <= EXPLORATION_SKIP_MAX_BYTES
    ) {
      // Skip the System1 call only when compaction settings are at their defaults. This avoids
      // bypassing explicit user limits (e.g. when they've lowered max-kept-lines or forced compaction).
      if (isDefaultCompactionConfig) {
        return {
          shouldCompact: false,
          skipReason: "exploration_output_small",
          triggeredByLines,
          triggeredByBytes,
          alreadyTargeted,
          intent,
          effectiveMaxKeptLines,
        };
      }
    }

    // Guardrail: only override when the caller still uses the default budget and thresholds.
    if (isDefaultCompactionConfig) {
      if (isConflictMarkerSearch) {
        effectiveMaxKeptLines = BASH_HARD_MAX_LINES;
      } else if (intent === "exploration") {
        effectiveMaxKeptLines = Math.min(
          BASH_HARD_MAX_LINES,
          Math.max(params.maxKeptLines, EXPLORATION_BOOST_MAX_KEPT_LINES)
        );
      }
    }
  }

  assert(
    Number.isInteger(effectiveMaxKeptLines) && effectiveMaxKeptLines > 0,
    "effectiveMaxKeptLines must be a positive integer"
  );

  return {
    shouldCompact: true,
    triggeredByLines,
    triggeredByBytes,
    alreadyTargeted,
    intent,
    effectiveMaxKeptLines,
  };
}
