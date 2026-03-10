import path from "node:path";

import type { MuxToolScope } from "@/common/types/toolScope";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";

import type { AgentSkillsRoots } from "./agentSkillsService";

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
  muxScope: Extract<MuxToolScope, { type: "project" }>
): AgentSkillsRoots {
  return {
    projectRoot: path.join(muxScope.projectRoot, ".mux", "skills"),
    projectUniversalRoot: path.join(muxScope.projectRoot, ".agents", "skills"),
    globalRoot: path.join(muxScope.muxHome, "skills"),
    universalRoot: "~/.agents/skills",
  };
}

function buildGlobalLocalRoots(input: {
  runtime: Runtime;
  muxScope?: MuxToolScope | null;
}): AgentSkillsRoots {
  const muxHome = input.muxScope?.muxHome ?? input.runtime.getMuxHome();

  return {
    projectRoot: "",
    globalRoot: path.join(muxHome, "skills"),
    universalRoot: "~/.agents/skills",
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
}): SkillStorageContext {
  if (input.muxScope?.type !== "project") {
    return {
      kind: "global-local",
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      // Keep system-scope discovery global-only so downstream readers do not
      // fall back to workspace-local roots when Chat with Mux reads skills.
      roots: buildGlobalLocalRoots({
        runtime: input.runtime,
        muxScope: input.muxScope,
      }),
      containment: { kind: "none" },
    };
  }

  if (input.muxScope.projectStorageAuthority === "runtime") {
    return {
      kind: "project-runtime",
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      containment: {
        kind: "runtime",
        root: input.workspacePath,
      },
    };
  }

  return {
    kind: "project-local",
    runtime: resolveProjectLocalRuntime({
      runtime: input.runtime,
      muxScope: input.muxScope,
    }),
    workspacePath: input.workspacePath,
    roots: buildProjectLocalRoots(input.muxScope),
    containment: {
      kind: "local",
      root: input.muxScope.projectRoot,
    },
  };
}
