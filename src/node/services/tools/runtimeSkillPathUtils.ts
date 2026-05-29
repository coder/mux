import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";

import { quoteRuntimeProbePath } from "./runtimePathShellQuote";
import { isAbsolutePathAny } from "./skillFileUtils";

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

function trimTrailingSeparators(pathValue: string): string {
  const normalized = normalizePathSeparators(pathValue);
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }

  return normalized.replace(/\/+$/u, "");
}

export function resolveSkillFilePathForRuntime(
  runtime: Runtime,
  skillDir: string,
  filePath: string
): {
  resolvedPath: string;
  normalizedRelativePath: string;
} {
  if (!filePath) {
    throw new Error("filePath is required");
  }

  if (isAbsolutePathAny(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid filePath (must be relative to the skill directory): ${filePath}`);
  }

  if (filePath.startsWith("..")) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  const resolvedPath = runtime.normalizePath(filePath, skillDir);
  const normalizedSkillDir = trimTrailingSeparators(skillDir);
  const normalizedResolvedPath = normalizePathSeparators(resolvedPath);
  const rootPrefix = normalizedSkillDir.endsWith("/")
    ? normalizedSkillDir
    : `${normalizedSkillDir}/`;

  if (
    normalizedResolvedPath !== normalizedSkillDir &&
    !normalizedResolvedPath.startsWith(rootPrefix)
  ) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  const normalizedRelativePath =
    normalizedResolvedPath === normalizedSkillDir
      ? ""
      : normalizedResolvedPath.slice(rootPrefix.length).replace(/^\/+/, "");

  if (normalizedRelativePath === "" || normalizedRelativePath === ".") {
    throw new Error(`Invalid filePath (expected a file, got directory): ${filePath}`);
  }

  if (
    normalizedRelativePath === ".." ||
    normalizedRelativePath.startsWith("../") ||
    normalizedRelativePath.includes("/../")
  ) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  return {
    resolvedPath,
    normalizedRelativePath,
  };
}

export async function inspectContainmentOnRuntime(
  runtime: Runtime,
  skillDir: string,
  targetPath: string
): Promise<{
  skillDirSymlink: boolean;
  withinRoot: boolean;
  leafSymlink: boolean;
  targetDirResolution: "direct" | "via-missing-ancestor";
}> {
  const script = `
resolve_real_allow_missing() {
  _current="$1"
  _missing_suffix=""
  while :; do
    _real_current=$(cd "$_current" 2>/dev/null && pwd -P) && {
      printf '%s%s\n' "$_real_current" "$_missing_suffix"
      return 0
    }
    _parent=$(dirname "$_current")
    [ "$_parent" = "$_current" ] && return 1
    _base=$(basename "$_current")
    _missing_suffix="/\${_base}\${_missing_suffix}"
    _current="$_parent"
  done
}

is_absolute_probe_path() {
  case "$1" in
    /*|[A-Za-z]:/*|[A-Za-z]:\\*|\\\\*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_target_allow_missing() {
  _candidate="$1"
  _visited=""
  _depth=0

  while [ "$_depth" -lt 40 ]; do
    printf '%s' "$_visited" | grep -F -x -- "$_candidate" >/dev/null 2>&1 && return 1
    _visited=$(printf '%s\n%s\n' "$_visited" "$_candidate")

    if test -L "$_candidate"; then
      _link_target=$(readlink "$_candidate" 2>/dev/null) || return 1
      [ -n "$_link_target" ] || return 1

      if is_absolute_probe_path "$_link_target"; then
        _candidate="$_link_target"
      else
        _candidate=$(dirname "$_candidate")/$_link_target
      fi

      _depth=$((_depth + 1))
      continue
    fi

    resolve_real_allow_missing "$_candidate"
    return $?
  done

  return 1
}

resolve_target_dir_resolution() {
  _target_path="$1"
  _target_dir=$(dirname "$_target_path")

  _real_target_dir=$(cd "$_target_dir" 2>/dev/null && pwd -P)
  if [ -n "$_real_target_dir" ]; then
    printf 'direct\n'
    return 0
  fi

  _real_target_dir=$(resolve_real_allow_missing "$_target_dir")
  if [ -n "$_real_target_dir" ]; then
    printf 'via-missing-ancestor\n'
    return 0
  fi

  printf 'direct\n'
}

SKILL_DIR=${quoteRuntimeProbePath(skillDir)}
TARGET=${quoteRuntimeProbePath(targetPath)}

if test -L "$SKILL_DIR"; then printf 'true\n'; else printf 'false\n'; fi

REAL_SKILL_DIR=$(cd "$SKILL_DIR" 2>/dev/null && pwd -P)
if [ -z "$REAL_SKILL_DIR" ]; then
  REAL_SKILL_DIR=$(resolve_real_allow_missing "$SKILL_DIR")
fi

if test -L "$TARGET"; then
  printf 'true\n'
else
  printf 'false\n'
fi

REAL_TARGET_PATH=$(resolve_target_allow_missing "$TARGET")
if [ -n "$REAL_TARGET_PATH" ]; then
  TARGET_DIR_RESOLUTION=$(resolve_target_dir_resolution "$REAL_TARGET_PATH")
else
  TARGET_DIR_RESOLUTION=$(resolve_target_dir_resolution "$TARGET")
fi

if [ -z "$REAL_SKILL_DIR" ] || [ -z "$REAL_TARGET_PATH" ]; then
  printf 'false\n'
else
  case "$REAL_TARGET_PATH" in
    "$REAL_SKILL_DIR"|"$REAL_SKILL_DIR"/*) printf 'true\n' ;;
    *) printf 'false\n' ;;
  esac
fi

printf '%s\n' "$TARGET_DIR_RESOLUTION"
`.trim();

  const result = await execBuffered(runtime, script, {
    cwd: "/",
    timeout: 10,
  });

  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Runtime containment probe failed: ${details}`);
  }

  const outputLines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const booleanLines = outputLines.slice(0, 3);
  const targetDirResolution = outputLines[3];

  if (
    outputLines.length !== 4 ||
    booleanLines.some((line) => line !== "true" && line !== "false") ||
    (targetDirResolution !== "direct" && targetDirResolution !== "via-missing-ancestor")
  ) {
    throw new Error(
      `Runtime containment probe returned unexpected output (expected 3 boolean lines + resolution marker): ${JSON.stringify(result.stdout)}`
    );
  }

  return {
    skillDirSymlink: outputLines[0] === "true",
    leafSymlink: outputLines[1] === "true",
    withinRoot: outputLines[2] === "true",
    targetDirResolution,
  };
}

export async function resolveContainedSkillFilePathOnRuntime(
  runtime: Runtime,
  skillDir: string,
  filePath: string
): Promise<{ resolvedPath: string; normalizedRelativePath: string }> {
  const resolvedTarget = resolveSkillFilePathForRuntime(runtime, skillDir, filePath);
  const probe = await inspectContainmentOnRuntime(runtime, skillDir, resolvedTarget.resolvedPath);

  // Do not reject symlinked skill directories or leaf files here.
  // Runtime containment is defined by the fully resolved target path staying inside the resolved
  // root; callers that want a stricter mutating-file policy must reject leaf symlinks separately.
  if (!probe.withinRoot) {
    throw new Error(
      `Invalid filePath (path escapes skill directory after symlink resolution): ${filePath}`
    );
  }

  return resolvedTarget;
}

export async function ensureRuntimePathWithinWorkspace(
  runtime: Runtime,
  workspacePath: string,
  targetPath: string,
  label: string
): Promise<void> {
  const probe = await inspectContainmentOnRuntime(runtime, workspacePath, targetPath);
  if (!probe.withinRoot) {
    throw new Error(`${label} resolves outside workspace root after symlink resolution.`);
  }
}
