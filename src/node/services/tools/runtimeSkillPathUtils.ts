import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";

import { isAbsolutePathAny } from "./skillFileUtils";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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

SKILL_DIR=${shellQuote(skillDir)}
TARGET=${shellQuote(targetPath)}

if test -L "$SKILL_DIR"; then printf 'true\n'; else printf 'false\n'; fi

REAL_SKILL_DIR=$(cd "$SKILL_DIR" 2>/dev/null && pwd -P)
TARGET_DIR=$(dirname "$TARGET")
TARGET_BASE=$(basename "$TARGET")

REAL_TARGET_DIR=$(cd "$TARGET_DIR" 2>/dev/null && pwd -P)
if [ -n "$REAL_TARGET_DIR" ]; then
  TARGET_DIR_RESOLUTION="direct"
else
  REAL_TARGET_DIR=$(resolve_real_allow_missing "$TARGET_DIR")
  if [ -n "$REAL_TARGET_DIR" ]; then
    TARGET_DIR_RESOLUTION="via-missing-ancestor"
  else
    TARGET_DIR_RESOLUTION="direct"
  fi
fi

if [ -z "$REAL_SKILL_DIR" ] || [ -z "$REAL_TARGET_DIR" ]; then
  printf 'false\n'
else
  case "$REAL_TARGET_DIR" in
    "$REAL_SKILL_DIR"|"$REAL_SKILL_DIR"/*) printf 'true\n' ;;
    *) printf 'false\n' ;;
  esac
fi

if test -L "$TARGET_DIR/$TARGET_BASE"; then printf 'true\n'; else printf 'false\n'; fi
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
    skillDirSymlink: booleanLines[0] === "true",
    withinRoot: booleanLines[1] === "true",
    leafSymlink: booleanLines[2] === "true",
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

  if (probe.skillDirSymlink) {
    throw new Error("Skill directory is a symbolic link and cannot be accessed.");
  }

  if (!probe.withinRoot) {
    throw new Error(
      `Invalid filePath (path escapes skill directory after symlink resolution): ${filePath}`
    );
  }

  if (probe.leafSymlink) {
    throw new Error(`Target file is a symbolic link and cannot be accessed: ${filePath}`);
  }

  return resolvedTarget;
}
