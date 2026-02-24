import type { ProjectsConfig } from "@/common/types/project";
import assert from "@/common/utils/assert";

/**
 * Check whether a project is trusted to run repo-level hooks, tool_env,
 * MCP servers, and agent/skill definitions from its .mux/ directory.
 *
 * Returns false only when the user has explicitly marked the project as
 * untrusted. Returns true for trusted projects and unknown project paths
 * (defensive: don't block tools if the project can't be looked up).
 */
export function isProjectTrusted(config: ProjectsConfig, projectPath: string): boolean {
  assert(
    typeof projectPath === "string" && projectPath.length > 0,
    "isProjectTrusted: projectPath must be a non-empty string"
  );

  const project = config.projects.get(projectPath);

  // Unknown projects (shouldn't happen) default to trusted to avoid breaking tools.
  // Explicitly untrusted (false) is the only case that blocks.
  return project?.trusted !== false;
}
