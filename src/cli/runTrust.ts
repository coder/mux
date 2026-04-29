import type { ProjectConfig, ProjectsConfig } from "@/node/config";
import * as path from "path";
import { resolveConfiguredProjectPathForTrust } from "@/node/utils/projectTrust";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

function toTrustOnlyProjectConfig(projectConfig: ProjectConfig): ProjectConfig | undefined {
  if (projectConfig.trusted === undefined) {
    return undefined;
  }

  return {
    workspaces: [],
    trusted: projectConfig.trusted,
  };
}

function deriveMuxRunProjectPath(projectDir: string, srcDir: string): string {
  const normalizedProjectDir = stripTrailingSlashes(projectDir);
  const normalizedSrcDir = stripTrailingSlashes(srcDir);

  if (normalizedProjectDir.startsWith(`${normalizedSrcDir}${path.sep}`)) {
    // Match AgentSession.ensureMetadata(): worktree-backed mux run sessions persist the
    // parent src bucket as projectPath rather than the specific checkout directory.
    return stripTrailingSlashes(path.dirname(normalizedProjectDir));
  }

  return normalizedProjectDir;
}

export function buildEphemeralRunConfig(
  tempConfig: ProjectsConfig,
  existingConfig: ProjectsConfig,
  projectDir: string,
  srcDir: string
): ProjectsConfig {
  return {
    ...tempConfig,
    // Keep mux run aligned with the desktop app's effective LSP provisioning mode,
    // including read-time env overrides, without importing unrelated workspace/task state.
    lspProvisioningMode: existingConfig.lspProvisioningMode,
    projects: buildTrustOnlyProjectsForRun(existingConfig.projects, projectDir, srcDir),
  };
}

export function buildTrustOnlyProjectsForRun(
  projects: ProjectsConfig["projects"],
  projectDir: string,
  srcDir: string
): Map<string, ProjectConfig> {
  const trustOnlyProjects = new Map<string, ProjectConfig>();

  for (const [projectPath, projectConfig] of projects) {
    const trustOnlyProjectConfig = toTrustOnlyProjectConfig(projectConfig);
    if (!trustOnlyProjectConfig) {
      continue;
    }

    trustOnlyProjects.set(projectPath, trustOnlyProjectConfig);
  }

  const normalizedProjectDir = stripTrailingSlashes(projectDir);
  const resolvedProjectPath = resolveConfiguredProjectPathForTrust(projects, {
    projectPath: normalizedProjectDir,
    namedWorkspacePath: normalizedProjectDir,
  });
  if (!resolvedProjectPath) {
    return trustOnlyProjects;
  }

  const resolvedProjectConfig = trustOnlyProjects.get(resolvedProjectPath);
  if (!resolvedProjectConfig) {
    return trustOnlyProjects;
  }

  const muxRunProjectPath =
    resolvedProjectPath === normalizedProjectDir
      ? normalizedProjectDir
      : deriveMuxRunProjectPath(normalizedProjectDir, srcDir);

  // Preserve trust for the exact projectPath key that mux run will write into session metadata,
  // without importing stored workspace/task records into the ephemeral CLI config.
  trustOnlyProjects.set(muxRunProjectPath, {
    workspaces: [],
    trusted: resolvedProjectConfig.trusted,
  });

  return trustOnlyProjects;
}
