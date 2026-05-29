/**
 * Extract the file path from a tool input object.
 *
 * Canonical field is `path`; legacy transcripts may contain `file_path` or `filePath`.
 * Returns `undefined` when no valid string is found.
 */
export function extractToolFilePath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const r = input as Record<string, unknown>;
  if (typeof r.path === "string") return r.path;
  if (typeof r.file_path === "string") return r.file_path;
  if (typeof r.filePath === "string") return r.filePath;
  return undefined;
}
