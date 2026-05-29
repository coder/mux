import { PlatformPaths } from "@/common/utils/paths";

function hashStringDjb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return hash >>> 0; // Unsigned 32-bit
}

function slugify(input: string): string {
  // Keep it URL-friendly and stable across platforms.
  // NOTE: This is for routing only (not user-facing display).
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "project";
}

export function getProjectRouteId(projectPath: string): string {
  const name = PlatformPaths.basename(projectPath);
  const hash = hashStringDjb2(projectPath).toString(16).padStart(8, "0");
  return `${slugify(name)}-${hash}`;
}
