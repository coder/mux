import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { quoteRuntimeProbePath } from "@/node/services/tools/runtimePathShellQuote";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { BUILT_IN_WORKFLOW_ACTION_SOURCES } from "./builtInWorkflowActions";

export type WorkflowActionScope = "project" | "global" | "built-in";

export interface WorkflowActionRegistryOptions {
  projectRoot: string;
  globalRoot: string;
  projectRuntime?: Runtime;
  projectCwd?: string;
}

export interface ResolvedWorkflowAction {
  name: string;
  scope: WorkflowActionScope;
  sourcePath: string;
  source: string;
  sourceHash: string;
}

interface ScannedWorkflowAction {
  name: string;
  scope: WorkflowActionScope;
  sourcePath: string;
}

const ACTION_NAME_SEGMENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const BUILT_IN_WORKFLOW_ACTION_ROOT = path.resolve(path.sep, "__mux_builtin_workflow_actions__");

export class WorkflowActionRegistry {
  private readonly projectRoot: string;
  private readonly globalRoot: string;
  private readonly projectRuntime?: Runtime;
  private readonly projectCwd?: string;

  constructor(options: WorkflowActionRegistryOptions) {
    assert(options.projectRoot.length > 0, "WorkflowActionRegistry: projectRoot is required");
    assert(options.globalRoot.length > 0, "WorkflowActionRegistry: globalRoot is required");
    assert(
      options.projectRuntime == null ||
        (options.projectCwd != null && options.projectCwd.length > 0),
      "WorkflowActionRegistry: projectCwd is required with projectRuntime"
    );
    this.projectRoot = options.projectRoot;
    this.globalRoot = options.globalRoot;
    this.projectRuntime = options.projectRuntime;
    this.projectCwd = options.projectCwd;
  }

  async listActions(options: { projectTrusted: boolean }): Promise<ScannedWorkflowAction[]> {
    if (this.projectRuntime != null) {
      return [];
    }
    const byName = await this.collectActions(options);
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveAction(
    name: string,
    options: { projectTrusted: boolean; builtInOnly?: boolean }
  ): Promise<ResolvedWorkflowAction> {
    const normalizedName = normalizeWorkflowActionName(name);
    if (options.builtInOnly === true) {
      const builtInAction = this.readBuiltInAction(normalizedName);
      if (builtInAction == null) {
        throw new Error(`Built-in workflow action not found: ${normalizedName}`);
      }
      if (this.projectRuntime != null && !isRunnerCoordinatedBuiltInAction(normalizedName)) {
        throw new Error("Workflow actions are not supported for runtime-backed workspaces yet");
      }
      return builtInAction;
    }

    if (options.projectTrusted) {
      const projectAction = await this.readProjectAction(normalizedName);
      if (projectAction != null) {
        return projectAction;
      }
    } else if (await this.projectActionExists(normalizedName)) {
      throw new Error(
        `Project trust is required to execute project-local workflow action: ${normalizedName}`
      );
    }

    const globalAction = await this.readLocalAction(normalizedName, this.globalRoot, "global");
    if (globalAction != null) {
      if (this.projectRuntime != null) {
        throw new Error("Workflow actions are not supported for runtime-backed workspaces yet");
      }
      return globalAction;
    }

    const builtInAction = this.readBuiltInAction(normalizedName);
    if (builtInAction != null) {
      if (this.projectRuntime != null && !isRunnerCoordinatedBuiltInAction(normalizedName)) {
        throw new Error("Workflow actions are not supported for runtime-backed workspaces yet");
      }
      return builtInAction;
    }

    throw new Error(`Workflow action not found: ${normalizedName}`);
  }

  private async collectActions(options: {
    projectTrusted: boolean;
  }): Promise<Map<string, ScannedWorkflowAction>> {
    const byName = new Map<string, ScannedWorkflowAction>();
    const sources: ScannedWorkflowAction[][] = [];
    if (options.projectTrusted && this.projectRuntime == null) {
      sources.push(await scanLocalActionDirectory(this.projectRoot, "project"));
    }
    sources.push(await scanLocalActionDirectory(this.globalRoot, "global"));
    sources.push(scanBuiltInActions());

    for (const source of sources) {
      for (const action of source) {
        if (!byName.has(action.name)) {
          byName.set(action.name, action);
        }
      }
    }
    return byName;
  }

  private async readProjectAction(name: string): Promise<ResolvedWorkflowAction | null> {
    if (this.projectRuntime != null) {
      const sourcePath = this.projectRuntime.normalizePath(
        actionNameToRelativePath(name),
        this.projectRoot
      );
      if (await this.runtimeActionPathExists(sourcePath)) {
        throw new Error(
          "Project-local workflow actions are not supported for runtime-backed workspaces yet"
        );
      }
      return null;
    }
    return await this.readLocalAction(name, this.projectRoot, "project");
  }

  private async readLocalAction(
    name: string,
    root: string,
    scope: WorkflowActionScope
  ): Promise<ResolvedWorkflowAction | null> {
    const sourcePath = path.join(root, actionNameToRelativePath(name));
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        return null;
      }
      const source = await fs.readFile(sourcePath, "utf-8");
      return {
        name,
        scope,
        sourcePath,
        source,
        sourceHash: await hashWorkflowActionSourceWithDependencies(sourcePath, source),
      };
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }
      throw new Error(`Unable to read workflow action '${sourcePath}': ${getErrorMessage(error)}`);
    }
  }

  private readBuiltInAction(name: string): ResolvedWorkflowAction | null {
    const source = getBuiltInActionSource(name);
    if (source == null) {
      return null;
    }
    const sourcePath = builtInActionSourcePath(name);
    return {
      name,
      scope: "built-in",
      sourcePath,
      source,
      sourceHash: hashWorkflowActionSource(source),
    };
  }

  private async projectActionExists(name: string): Promise<boolean> {
    if (this.projectRuntime != null) {
      const sourcePath = this.projectRuntime.normalizePath(
        actionNameToRelativePath(name),
        this.projectRoot
      );
      return await this.runtimeActionPathExists(sourcePath);
    }
    return await localPathExists(path.join(this.projectRoot, actionNameToRelativePath(name)));
  }

  private async runtimeActionPathExists(sourcePath: string): Promise<boolean> {
    if (this.projectRuntime == null || this.projectCwd == null) {
      return false;
    }
    const result = await execBuffered(
      this.projectRuntime,
      `[ -f ${quoteRuntimeProbePath(sourcePath)} ]`,
      { cwd: this.projectCwd, timeout: 5 }
    );
    return result.exitCode === 0;
  }
}

function isRunnerCoordinatedBuiltInAction(name: string): boolean {
  return name === "workflows.start";
}

function normalizeWorkflowActionName(name: string): string {
  assert(typeof name === "string", "Workflow action name must be a string");
  const normalized = name.trim();
  assert(normalized.length > 0, "Workflow action name is required");
  const segments = normalized.split(".");
  assert(
    segments.every((segment) => ACTION_NAME_SEGMENT_PATTERN.test(segment)),
    `Workflow action name must use JavaScript identifier path segments: ${normalized}`
  );
  return segments.join(".");
}

export function hashWorkflowActionSource(source: string): string {
  assert(typeof source === "string", "Workflow action source must be a string");
  return `sha256:${crypto.createHash("sha256").update(source).digest("hex")}`;
}

const WORKFLOW_ACTION_DEPENDENCY_LIMIT = 64;
const STATIC_REQUIRE_PATTERN = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/gu;

async function hashWorkflowActionSourceWithDependencies(
  sourcePath: string,
  source: string
): Promise<string> {
  const dependencies: Array<{ sourcePath: string; source: string }> = [];
  await collectStaticRelativeDependencies(sourcePath, source, dependencies, new Set([sourcePath]));
  if (dependencies.length === 0) {
    return hashWorkflowActionSource(source);
  }
  const hash = crypto.createHash("sha256").update(source);
  for (const dependency of dependencies.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
    hash.update("\0dependency\0");
    hash.update(dependency.sourcePath);
    hash.update("\0");
    hash.update(dependency.source);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectStaticRelativeDependencies(
  sourcePath: string,
  source: string,
  dependencies: Array<{ sourcePath: string; source: string }>,
  seenPaths: Set<string>
): Promise<void> {
  for (const specifier of getStaticRequireSpecifiers(source)) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      continue;
    }
    const dependencyPath = await resolveRelativeRequirePath(path.dirname(sourcePath), specifier);
    if (dependencyPath == null || seenPaths.has(dependencyPath)) {
      continue;
    }
    assert(
      dependencies.length < WORKFLOW_ACTION_DEPENDENCY_LIMIT,
      `Workflow action static dependency limit exceeded: ${WORKFLOW_ACTION_DEPENDENCY_LIMIT}`
    );
    seenPaths.add(dependencyPath);
    const dependencySource = await fs.readFile(dependencyPath, "utf-8");
    dependencies.push({ sourcePath: dependencyPath, source: dependencySource });
    await collectStaticRelativeDependencies(
      dependencyPath,
      dependencySource,
      dependencies,
      seenPaths
    );
  }
}

function getStaticRequireSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_REQUIRE_PATTERN)) {
    const specifier = match[2];
    if (specifier != null) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

async function resolveRelativeRequirePath(
  baseDir: string,
  specifier: string
): Promise<string | null> {
  const basePath = path.resolve(baseDir, specifier);
  for (const candidate of [
    basePath,
    `${basePath}.js`,
    `${basePath}.json`,
    path.join(basePath, "index.js"),
  ]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function actionNameToRelativePath(name: string): string {
  return path.join(...normalizeWorkflowActionName(name).split(".")) + ".js";
}

function getBuiltInActionSource(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_WORKFLOW_ACTION_SOURCES, name)
    ? BUILT_IN_WORKFLOW_ACTION_SOURCES[name]
    : null;
}

function builtInActionSourcePath(name: string): string {
  return path.join(BUILT_IN_WORKFLOW_ACTION_ROOT, actionNameToRelativePath(name));
}

function scanBuiltInActions(): ScannedWorkflowAction[] {
  return Object.keys(BUILT_IN_WORKFLOW_ACTION_SOURCES).map((name) => ({
    name,
    scope: "built-in" as const,
    sourcePath: builtInActionSourcePath(name),
  }));
}

async function scanLocalActionDirectory(
  root: string,
  scope: WorkflowActionScope
): Promise<ScannedWorkflowAction[]> {
  const actions: ScannedWorkflowAction[] = [];
  await scanLocalActionDirectoryRecursive(root, root, scope, actions);
  return actions;
}

async function scanLocalActionDirectoryRecursive(
  root: string,
  current: string,
  scope: WorkflowActionScope,
  actions: ScannedWorkflowAction[]
): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await scanLocalActionDirectoryRecursive(root, entryPath, scope, actions);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    const relativePath = path.relative(root, entryPath);
    const actionName = actionNameFromRelativePath(relativePath);
    if (actionName == null) {
      log.warn(`Skipping workflow action with invalid path '${entryPath}'`);
      continue;
    }
    actions.push({ name: actionName, scope, sourcePath: entryPath });
  }
}

function actionNameFromRelativePath(relativePath: string): string | null {
  const normalizedPath = relativePath.replace(/\\/gu, "/");
  if (!normalizedPath.endsWith(".js")) {
    return null;
  }
  const segments = normalizedPath
    .slice(0, -".js".length)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    !segments.every((segment) => ACTION_NAME_SEGMENT_PATTERN.test(segment))
  ) {
    return null;
  }
  return segments.join(".");
}

function isMissingPathError(error: unknown): boolean {
  if (error == null || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function localPathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
