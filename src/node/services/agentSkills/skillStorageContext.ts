import path from "node:path";

import type { MuxToolScope } from "@/common/types/toolScope";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";

import {
  buildProjectSkillRoots,
  getDefaultAgentSkillsRoots,
  type AgentSkillsRoots,
} from "./agentSkillsService";

export type SkillStorageKind = "global-local" | "project-local" | "project-runtime";

export type ProjectSkillContainment =
  | { kind: "none" }
  | { kind: "local"; root: string }
  | { kind: "runtime"; root: string };

export interface SkillStorageContext {
  kind: SkillStorageKind;
  runtime: Runtime;
  workspacePath: string;
  roots?: AgentSkillsRoots;
  containment: ProjectSkillContainment;
}

function buildProjectLocalRoots(
  runtime: Runtime,
  muxScope: Extract<MuxToolScope, { type: "project" }>,
  options?: { includeClaudeSkills?: boolean; includeAgentPlugins?: boolean }
): AgentSkillsRoots {
  const projectSearchRoot = muxScope.checkoutRoot ?? muxScope.projectRoot;

  return {
    projectRoot: path.join(muxScope.projectRoot, ".mux", "skills"),
    projectUniversalRoot: path.join(muxScope.projectRoot, ".agents", "skills"),
    ...(projectSearchRoot !== muxScope.projectRoot
      ? {
          // Subprojects inherit skills from every ancestor through the checkout
          // root. The ordered list keeps the nearest definition authoritative.
          projectSearchRoot,
          projectRoots: buildProjectSkillRoots(runtime, muxScope.projectRoot, projectSearchRoot, {
            includeClaudeSkills: options?.includeClaudeSkills,
          }),
        }
      : {}),
    globalRoot: path.join(muxScope.muxHome, "skills"),
    universalRoot: "~/.agents/skills",
    // claude-skills-compat experiment: read-only roots at lowest precedence within each scope.
    ...(options?.includeClaudeSkills
      ? {
          projectClaudeRoot: path.join(muxScope.projectRoot, ".claude", "skills"),
          globalClaudeRoot: "~/.claude/skills",
        }
      : {}),
    // agent-plugins experiment: read-only plugin containers at lowest precedence within each scope.
    // Containers anchor at the CHECKOUT root: for subProjectPath workspaces
    // `projectRoot` is the execution subdirectory, but plugins live (and are
    // listed by the UI) at the checkout level.
    ...(options?.includeAgentPlugins
      ? {
          projectPluginRoots: [
            path.join(muxScope.checkoutRoot ?? muxScope.projectRoot, ".mux", "plugins"),
            path.join(muxScope.checkoutRoot ?? muxScope.projectRoot, ".agents", "plugins"),
          ],
          globalPluginRoots: [path.join(muxScope.muxHome, "plugins"), "~/.agents/plugins"],
        }
      : {}),
  };
}

function buildGlobalLocalRoots(input: {
  runtime: Runtime;
  muxScope?: MuxToolScope | null;
  includeClaudeSkills?: boolean;
  includeAgentPlugins?: boolean;
}): AgentSkillsRoots {
  const muxHome = input.muxScope?.muxHome ?? input.runtime.getMuxHome();

  return {
    projectRoot: "",
    globalRoot: path.join(muxHome, "skills"),
    universalRoot: "~/.agents/skills",
    // claude-skills-compat experiment: read-only root at lowest global precedence.
    ...(input.includeClaudeSkills ? { globalClaudeRoot: "~/.claude/skills" } : {}),
    // agent-plugins experiment: read-only plugin containers at lowest global precedence.
    ...(input.includeAgentPlugins
      ? { globalPluginRoots: [path.join(muxHome, "plugins"), "~/.agents/plugins"] }
      : {}),
  };
}

function resolveProjectLocalRuntime(input: {
  runtime: Runtime;
  muxScope: Extract<MuxToolScope, { type: "project" }>;
}): Runtime {
  if (input.runtime instanceof DevcontainerRuntime) {
    // Devcontainer commands run in the container, but project-local skill roots point at
    // host paths. Use host-local I/O here so discovery can still reach host-global skills.
    return new LocalRuntime(input.muxScope.projectRoot);
  }

  return input.runtime;
}

/**
 * Resolve skill storage context from workspace scope, swapping in a host-local runtime
 * when the selected skill roots live on the host filesystem.
 */
export function resolveSkillStorageContext(input: {
  runtime: Runtime;
  workspacePath: string;
  muxScope?: MuxToolScope | null;
  /** claude-skills-compat experiment: include read-only .claude/skills roots in discovery. */
  includeClaudeSkills?: boolean;
  /** agent-plugins experiment: include read-only Agent Plugins skill roots in discovery. */
  includeAgentPlugins?: boolean;
}): SkillStorageContext {
  if (input.muxScope?.type !== "project") {
    return {
      kind: "global-local",
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      // Keep global-scope discovery global-only so downstream readers do not
      // fall back to workspace-local roots when the caller targets ~/.mux.
      roots: buildGlobalLocalRoots({
        runtime: input.runtime,
        muxScope: input.muxScope,
        includeClaudeSkills: input.includeClaudeSkills,
        includeAgentPlugins: input.includeAgentPlugins,
      }),
      containment: { kind: "none" },
    };
  }

  const projectSearchRoot = input.muxScope.checkoutRoot ?? input.workspacePath;
  if (input.muxScope.projectStorageAuthority === "runtime") {
    return {
      kind: "project-runtime",
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      roots: getDefaultAgentSkillsRoots(input.runtime, input.workspacePath, {
        includeClaudeSkills: input.includeClaudeSkills,
        includeAgentPlugins: input.includeAgentPlugins,
        projectSearchRoot,
      }),
      containment: {
        kind: "runtime",
        root: projectSearchRoot,
      },
    };
  }

  const projectRuntime = resolveProjectLocalRuntime({
    runtime: input.runtime,
    muxScope: input.muxScope,
  });
  return {
    kind: "project-local",
    runtime: projectRuntime,
    workspacePath: input.workspacePath,
    roots: buildProjectLocalRoots(projectRuntime, input.muxScope, {
      includeClaudeSkills: input.includeClaudeSkills,
      includeAgentPlugins: input.includeAgentPlugins,
    }),
    containment: {
      kind: "local",
      // The checkout root (when present) contains projectRoot, so this stays a
      // correct repo boundary while also covering inherited and plugin roots.
      root: input.muxScope.checkoutRoot ?? input.muxScope.projectRoot,
    },
  };
}
