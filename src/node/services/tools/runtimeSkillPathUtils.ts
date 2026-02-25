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
}> {
  const script = `
SKILL_DIR=${shellQuote(skillDir)}
TARGET=${shellQuote(targetPath)}

if test -L "$SKILL_DIR"; then echo "true"; else echo "false"; fi

REAL_SKILL_DIR=$(cd "$SKILL_DIR" 2>/dev/null && pwd -P)
TARGET_DIR=$(dirname "$TARGET")
TARGET_BASE=$(basename "$TARGET")
REAL_TARGET_DIR=$(cd "$TARGET_DIR" 2>/dev/null && pwd -P)
if [ -z "$REAL_SKILL_DIR" ] || [ -z "$REAL_TARGET_DIR" ]; then
  echo "false"
else
  case "$REAL_TARGET_DIR" in
    "$REAL_SKILL_DIR"|"$REAL_SKILL_DIR"/*) echo "true" ;;
    *) echo "false" ;;
  esac
fi

if test -L "$TARGET_DIR/$TARGET_BASE"; then echo "true"; else echo "false"; fi
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

  if (outputLines.length !== 3 || outputLines.some((line) => line !== "true" && line !== "false")) {
    throw new Error(
      `Runtime containment probe returned unexpected output (expected 3 boolean lines): ${JSON.stringify(result.stdout)}`
    );
  }

  return {
    skillDirSymlink: outputLines[0] === "true",
    withinRoot: outputLines[1] === "true",
    leafSymlink: outputLines[2] === "true",
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
