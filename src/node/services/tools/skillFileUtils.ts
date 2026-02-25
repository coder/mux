import * as path from "path";

export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function isAbsolutePathAny(filePath: string): boolean {
  if (filePath.startsWith("/") || filePath.startsWith("\\")) {
    return true;
  }

  return /^[A-Za-z]:[\\/]/.test(filePath);
}

export function resolveSkillFilePath(
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

  const resolvedPath = path.resolve(skillDir, filePath);
  const relativePath = path.relative(skillDir, resolvedPath);

  if (relativePath === "" || relativePath === ".") {
    throw new Error(`Invalid filePath (expected a file, got directory): ${filePath}`);
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  return {
    resolvedPath,
    normalizedRelativePath: relativePath.replaceAll(path.sep, "/"),
  };
}
