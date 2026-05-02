import type { ProjectConfig } from "@/common/types/project";
import { PlatformPaths } from "@/common/utils/paths";

function normalizeForDescendantComparison(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows paths are case-insensitive, and user input / persisted config can
  // differ in drive-letter or segment casing. Treat drive-letter paths as
  // case-insensitive so hierarchy derivation is stable on Windows while POSIX
  // paths keep their normal case-sensitive semantics.
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function isPathDescendant(parentPath: string, candidatePath: string): boolean {
  const parent = normalizeForDescendantComparison(parentPath);
  const candidate = normalizeForDescendantComparison(candidatePath);
  return candidate.startsWith(`${parent}/`) && candidate.length > parent.length + 1;
}

export function getDirectParentProjectPath(
  projectPath: string,
  projects: Map<string, ProjectConfig>
): string | null {
  const ancestorPaths = Array.from(projects.keys()).filter(
    (candidatePath) => candidatePath !== projectPath && isPathDescendant(candidatePath, projectPath)
  );

  const topLevelAncestors = ancestorPaths.filter(
    (ancestorPath) =>
      !ancestorPaths.some(
        (otherAncestorPath) =>
          otherAncestorPath !== ancestorPath && isPathDescendant(otherAncestorPath, ancestorPath)
      )
  );

  return topLevelAncestors.sort((left, right) => right.length - left.length)[0] ?? null;
}

export function deriveProjectHierarchy(
  projects: Map<string, ProjectConfig>
): Map<string, ProjectConfig> {
  const next = new Map<string, ProjectConfig>();
  for (const [projectPath, projectConfig] of projects) {
    next.set(projectPath, { ...projectConfig, parentProjectPath: undefined });
  }

  for (const [projectPath, projectConfig] of next) {
    const parentProjectPath = getDirectParentProjectPath(projectPath, next);
    if (!parentProjectPath) {
      next.set(projectPath, { ...projectConfig, parentProjectPath: undefined });
      continue;
    }
    next.set(projectPath, { ...projectConfig, parentProjectPath });
  }

  return next;
}

export function getTopLevelProjectPath(
  projectPath: string,
  projects: Map<string, ProjectConfig>
): string {
  return projects.get(projectPath)?.parentProjectPath ?? projectPath;
}

export function getSubProjectsForParent(
  parentProjectPath: string,
  projects: Map<string, ProjectConfig>
): Array<[string, ProjectConfig]> {
  return Array.from(projects.entries())
    .filter(([, projectConfig]) => projectConfig.parentProjectPath === parentProjectPath)
    .sort((left, right) =>
      getProjectDisplayName(left[0], left[1]).localeCompare(
        getProjectDisplayName(right[0], right[1]),
        undefined,
        { sensitivity: "base" }
      )
    );
}

export function getProjectDisplayName(projectPath: string, projectConfig?: ProjectConfig): string {
  const displayName = projectConfig?.displayName?.trim();
  return displayName && displayName.length > 0
    ? displayName
    : PlatformPaths.getProjectName(projectPath);
}

export function formatProjectHierarchyLabel(
  projectPath: string,
  projects: Map<string, ProjectConfig>
): string {
  const projectConfig = projects.get(projectPath);
  const parentProjectPath = projectConfig?.parentProjectPath;
  const projectName = getProjectDisplayName(projectPath, projectConfig);
  if (!parentProjectPath) {
    return projectName;
  }
  return `${getProjectDisplayName(parentProjectPath, projects.get(parentProjectPath))} / ${projectName}`;
}
