import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { quoteRuntimeProbePath } from "@/node/services/tools/runtimePathShellQuote";
import { execBuffered, readFileString } from "@/node/utils/runtime/helpers";

export type WorkflowActionScope = "project" | "global";

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
    const byName = await this.collectActions(options);
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveAction(
    name: string,
    options: { projectTrusted: boolean }
  ): Promise<ResolvedWorkflowAction> {
    const normalizedName = normalizeWorkflowActionName(name);
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
      return globalAction;
    }

    throw new Error(`Workflow action not found: ${normalizedName}`);
  }

  private async collectActions(options: {
    projectTrusted: boolean;
  }): Promise<Map<string, ScannedWorkflowAction>> {
    const byName = new Map<string, ScannedWorkflowAction>();
    const sources: ScannedWorkflowAction[][] = [];
    if (options.projectTrusted) {
      if (this.projectRuntime != null) {
        assert(
          this.projectCwd != null,
          "WorkflowActionRegistry.collectActions: projectCwd missing"
        );
        sources.push(
          await scanRuntimeActionDirectory(this.projectRuntime, this.projectRoot, this.projectCwd)
        );
      } else {
        sources.push(await scanLocalActionDirectory(this.projectRoot, "project"));
      }
    }
    sources.push(await scanLocalActionDirectory(this.globalRoot, "global"));

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
      assert(
        this.projectCwd != null,
        "WorkflowActionRegistry.readProjectAction: projectCwd missing"
      );
      const sourcePath = this.projectRuntime.normalizePath(
        actionNameToRelativePath(name),
        this.projectRoot
      );
      try {
        const source = await readFileString(this.projectRuntime, sourcePath);
        return {
          name,
          scope: "project",
          sourcePath,
          source,
          sourceHash: hashWorkflowActionSource(source),
        };
      } catch (error) {
        if (await this.runtimeActionPathExists(sourcePath)) {
          log.warn(
            `Skipping unreadable runtime workflow action '${sourcePath}': ${getErrorMessage(error)}`
          );
        }
        return null;
      }
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
      return { name, scope, sourcePath, source, sourceHash: hashWorkflowActionSource(source) };
    } catch (error) {
      if (await localPathExists(sourcePath)) {
        log.warn(`Skipping unreadable workflow action '${sourcePath}': ${getErrorMessage(error)}`);
      }
      return null;
    }
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

export function normalizeWorkflowActionName(name: string): string {
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

function actionNameToRelativePath(name: string): string {
  return path.join(...normalizeWorkflowActionName(name).split(".")) + ".js";
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

async function scanRuntimeActionDirectory(
  runtime: Runtime,
  root: string,
  cwd: string
): Promise<ScannedWorkflowAction[]> {
  let stdout: string;
  try {
    const quotedRoot = quoteRuntimeProbePath(root);
    const result = await execBuffered(
      runtime,
      `if [ ! -d ${quotedRoot} ]; then exit 0; fi
cd ${quotedRoot} || exit 1
find . -type f -name '*.js' -print`,
      { cwd, timeout: 10 }
    );
    if (result.exitCode !== 0) {
      const details =
        result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(details);
    }
    stdout = result.stdout;
  } catch (error) {
    log.warn(`Skipping runtime workflow action root '${root}': ${getErrorMessage(error)}`);
    return [];
  }

  const actions: ScannedWorkflowAction[] = [];
  for (const line of stdout.split("\n")) {
    const relativePath = line.trim().replace(/^\.\//u, "");
    if (relativePath.length === 0) {
      continue;
    }
    const actionName = actionNameFromRelativePath(relativePath);
    if (actionName == null) {
      log.warn(`Skipping runtime workflow action with invalid path '${relativePath}' in ${root}`);
      continue;
    }
    actions.push({
      name: actionName,
      scope: "project",
      sourcePath: runtime.normalizePath(relativePath, root),
    });
  }
  return actions;
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

async function localPathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
