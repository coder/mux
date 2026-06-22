import * as crypto from "node:crypto";
import * as path from "node:path";

import { SkillNameSchema } from "@/common/orpc/schemas";
import type { AgentSkillScope, SkillName } from "@/common/types/agentSkill";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  readAgentSkill,
  type AgentSkillsRoots,
} from "@/node/services/agentSkills/agentSkillsService";
import { readBuiltInSkillFile } from "@/node/services/agentSkills/builtInSkillDefinitions";
import { validateFileSize } from "@/node/services/tools/fileCommon";
import {
  ensureRuntimePathWithinWorkspace,
  resolveContainedSkillFilePathOnRuntime,
} from "@/node/services/tools/runtimeSkillPathUtils";
import { isAbsolutePathAny } from "@/node/services/tools/skillFileUtils";
import { readFileString } from "@/node/utils/runtime/helpers";

export type WorkflowScriptSourceKind = "skill" | "workspace-file";

export interface ResolvedWorkflowScript {
  requestedScriptPath: string;
  canonicalScriptPath: string;
  source: string;
  sourceHash: string;
  sourceKind: WorkflowScriptSourceKind;
  scope?: AgentSkillScope;
  skillName?: SkillName;
  relativePath?: string;
  resolvedPath?: string;
}

export interface ResolveWorkflowScriptInput {
  scriptPath: string;
  runtime: Runtime;
  workspacePath: string;
  projectTrusted: boolean;
  roots?: AgentSkillsRoots;
}

const SKILL_SCRIPT_PATH_PREFIX = "skill://";

export async function resolveWorkflowScript(
  input: ResolveWorkflowScriptInput
): Promise<ResolvedWorkflowScript> {
  const scriptPath = input.scriptPath.trim();
  assert(scriptPath.length > 0, "resolveWorkflowScript: scriptPath is required");
  assert(input.workspacePath.length > 0, "resolveWorkflowScript: workspacePath is required");

  if (scriptPath.startsWith(SKILL_SCRIPT_PATH_PREFIX)) {
    return await resolveSkillWorkflowScript({ ...input, scriptPath });
  }

  return await resolveWorkspaceFileWorkflowScript({ ...input, scriptPath });
}

async function resolveSkillWorkflowScript(
  input: ResolveWorkflowScriptInput & { scriptPath: string }
): Promise<ResolvedWorkflowScript> {
  const parsed = parseSkillWorkflowScriptPath(input.scriptPath);
  assertJavaScriptWorkflowPath(parsed.relativePath);

  const resolvedSkill = await readAgentSkill(input.runtime, input.workspacePath, parsed.skillName, {
    ...(input.roots != null ? { roots: input.roots } : {}),
    containment: { kind: "runtime", root: input.workspacePath },
  });

  if (resolvedSkill.package.scope === "project" && !input.projectTrusted) {
    throw new Error("Project trust is required to run project skill workflow scripts");
  }

  if (resolvedSkill.package.scope === "built-in") {
    const builtIn = readBuiltInSkillFile(parsed.skillName, parsed.relativePath);
    return buildResolvedScript({
      requestedScriptPath: input.scriptPath,
      canonicalScriptPath: `skill://${parsed.skillName}/${builtIn.resolvedPath}`,
      source: builtIn.content,
      sourceKind: "skill",
      scope: "built-in",
      skillName: parsed.skillName,
      relativePath: builtIn.resolvedPath,
    });
  }

  const skillRuntime = resolvedSkill.sourceRuntime;
  assert(skillRuntime != null, "resolveWorkflowScript: non-built-in skill runtime is required");

  const resolvedPath = (
    await resolveContainedSkillFilePathOnRuntime(
      skillRuntime,
      resolvedSkill.skillDir,
      parsed.relativePath
    )
  ).resolvedPath;

  const stat = await skillRuntime.stat(resolvedPath);
  assertRegularJavaScriptFile(stat.isDirectory, parsed.relativePath);
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation != null) {
    throw new Error(sizeValidation.error);
  }

  const source = await readFileString(skillRuntime, resolvedPath);
  return buildResolvedScript({
    requestedScriptPath: input.scriptPath,
    canonicalScriptPath: `skill://${parsed.skillName}/${parsed.relativePath}`,
    source,
    sourceKind: "skill",
    scope: resolvedSkill.package.scope,
    skillName: parsed.skillName,
    relativePath: parsed.relativePath,
    resolvedPath,
  });
}

async function resolveWorkspaceFileWorkflowScript(
  input: ResolveWorkflowScriptInput & { scriptPath: string }
): Promise<ResolvedWorkflowScript> {
  if (!input.projectTrusted) {
    throw new Error("Project trust is required to run workspace workflow scripts");
  }
  assertJavaScriptWorkflowPath(input.scriptPath);

  const resolvedPath = input.runtime.normalizePath(input.scriptPath, input.workspacePath);
  await ensureRuntimePathWithinWorkspace(
    input.runtime,
    input.workspacePath,
    resolvedPath,
    "Workflow script path"
  ).catch((error: unknown) => {
    throw new Error(
      `Workflow script path resolves outside the workspace: ${getErrorMessage(error)}`
    );
  });

  const stat = await input.runtime.stat(resolvedPath);
  assertRegularJavaScriptFile(stat.isDirectory, input.scriptPath);
  const sizeValidation = validateFileSize(stat);
  if (sizeValidation != null) {
    throw new Error(sizeValidation.error);
  }

  const source = await readFileString(input.runtime, resolvedPath);
  return buildResolvedScript({
    requestedScriptPath: input.scriptPath,
    canonicalScriptPath: input.scriptPath,
    source,
    sourceKind: "workspace-file",
    resolvedPath,
  });
}

function parseSkillWorkflowScriptPath(scriptPath: string): {
  skillName: SkillName;
  relativePath: string;
} {
  const remainder = scriptPath.slice(SKILL_SCRIPT_PATH_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex <= 0 || slashIndex === remainder.length - 1) {
    throw new Error("skill:// workflow script paths must include a relative .js file path");
  }

  const parsedName = SkillNameSchema.safeParse(remainder.slice(0, slashIndex));
  if (!parsedName.success) {
    throw new Error(`Invalid workflow skill name: ${parsedName.error.message}`);
  }

  const relativePath = normalizeSkillRelativePath(remainder.slice(slashIndex + 1));
  return { skillName: parsedName.data, relativePath };
}

function normalizeSkillRelativePath(filePath: string): string {
  if (isAbsolutePathAny(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid skill workflow path (must be relative): ${filePath}`);
  }

  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  const stripped = normalized.startsWith("./") ? normalized.slice(2) : normalized;
  if (stripped === "" || stripped === "." || stripped.endsWith("/")) {
    throw new Error("skill:// workflow script paths must include a relative .js file path");
  }
  if (stripped === ".." || stripped.startsWith("../") || stripped.includes("/../")) {
    throw new Error(`Invalid skill workflow path (path traversal): ${filePath}`);
  }
  return stripped;
}

function assertJavaScriptWorkflowPath(scriptPath: string): void {
  if (!scriptPath.endsWith(".js")) {
    throw new Error(`Workflow script paths must point to a .js file: ${scriptPath}`);
  }
}

function assertRegularJavaScriptFile(isDirectory: boolean, scriptPath: string): void {
  assertJavaScriptWorkflowPath(scriptPath);
  if (isDirectory) {
    throw new Error(`Workflow script path must point to a regular JavaScript file: ${scriptPath}`);
  }
}

function buildResolvedScript(
  input: Omit<ResolvedWorkflowScript, "sourceHash">
): ResolvedWorkflowScript {
  assert(input.source.length > 0, "resolveWorkflowScript: workflow script source is empty");
  return {
    ...input,
    sourceHash: hashSource(input.source),
  };
}

function hashSource(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}
