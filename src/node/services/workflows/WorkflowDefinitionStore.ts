import * as fs from "node:fs/promises";
import * as path from "node:path";

import { WorkflowDefinitionDescriptorSchema, WorkflowNameSchema } from "@/common/orpc/schemas";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import type { WorkflowDefinitionDescriptor, WorkflowName } from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { quoteRuntimeProbePath } from "@/node/services/tools/runtimePathShellQuote";
import { execFileAsync } from "@/node/utils/disposableExec";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import {
  BUILT_IN_WORKFLOW_DEFINITIONS,
  type BuiltInWorkflowDefinition,
} from "./builtInWorkflowDefinitions";

export interface WorkflowDefinitionStoreOptions {
  projectRoot: string;
  globalRoot: string;
  scratchRoot?: string;
  projectRuntime?: Runtime;
  projectCwd?: string;
  builtIns?: readonly BuiltInWorkflowDefinition[];
}

export function shouldUseRuntimeWorkflowProjectIO(runtimeType: RuntimeMode): boolean {
  return runtimeType === RUNTIME_MODE.SSH || runtimeType === RUNTIME_MODE.DOCKER;
}

export function shouldDisableHostWorkflowActions(runtimeType: RuntimeMode): boolean {
  return (
    shouldUseRuntimeWorkflowProjectIO(runtimeType) || runtimeType === RUNTIME_MODE.DEVCONTAINER
  );
}

export type WorkflowPromotionLocation = "project" | "global";

export interface PromoteWorkflowDefinitionInput {
  name: string;
  description: string;
  source: string;
  location: WorkflowPromotionLocation;
  overwrite: boolean;
  projectTrusted: boolean;
}

export interface WorkflowDefinitionReadResult {
  descriptor: WorkflowDefinitionDescriptor;
  source: string;
}

interface ScannedWorkflowDefinition {
  descriptor: WorkflowDefinitionDescriptor;
  source: string;
}

const DESCRIPTION_PREFIX = "// description:";
const WORKFLOW_SCRATCH_GIT_EXCLUDE_COMMENT = "# mux: local scratch workflow drafts";
const WORKFLOW_SCRATCH_GITIGNORE_FALLBACK_COMMENT =
  "# mux: hide scratch workflow drafts when repo rules unignore workflows";
const LOCAL_GIT_COMMAND_TIMEOUT_MS = 5_000;
const RUNTIME_GIT_COMMAND_TIMEOUT_SECONDS = 5;

function parseWorkflowDescription(source: string): string | null {
  const firstMeaningfulLine = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstMeaningfulLine?.startsWith(DESCRIPTION_PREFIX)) {
    return null;
  }

  const description = firstMeaningfulLine.slice(DESCRIPTION_PREFIX.length).trim();
  return description.length > 0 ? description : null;
}

function descriptorForFile(args: {
  name: WorkflowName;
  description: string;
  scope: "project" | "global" | "scratch";
  sourcePath: string;
}): WorkflowDefinitionDescriptor | null {
  const descriptor = {
    name: args.name,
    description: args.description,
    scope: args.scope,
    sourcePath: args.sourcePath,
    executable: true,
  } satisfies WorkflowDefinitionDescriptor;

  const parsed = WorkflowDefinitionDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) {
    log.warn(`Invalid workflow definition descriptor '${args.name}': ${parsed.error.message}`);
    return null;
  }

  return parsed.data;
}

async function scanDirectory(
  root: string,
  scope: "project" | "global" | "scratch"
): Promise<ScannedWorkflowDefinition[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const definitions: ScannedWorkflowDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".js")) {
      continue;
    }

    const rawName = entry.slice(0, -".js".length);
    const nameResult = WorkflowNameSchema.safeParse(rawName);
    if (!nameResult.success) {
      log.warn(`Skipping invalid workflow filename '${entry}' in ${root}`);
      continue;
    }

    const sourcePath = path.join(root, entry);
    let source: string;
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        continue;
      }
      source = await fs.readFile(sourcePath, "utf-8");
    } catch (error) {
      log.warn(`Skipping unreadable workflow '${sourcePath}': ${getErrorMessage(error)}`);
      continue;
    }

    const description = parseWorkflowDescription(source);
    if (description == null) {
      log.warn(`Skipping workflow '${sourcePath}' because it is missing a description header`);
      continue;
    }

    const descriptor = descriptorForFile({
      name: nameResult.data,
      description,
      scope,
      sourcePath,
    });
    if (descriptor == null) {
      continue;
    }

    definitions.push({ descriptor, source });
  }

  return definitions;
}

async function listRuntimeWorkflowFilenames(
  runtime: Runtime,
  root: string,
  cwd: string
): Promise<string[]> {
  const quotedRoot = quoteRuntimeProbePath(root);
  const result = await execBuffered(
    runtime,
    `if [ ! -d ${quotedRoot} ]; then exit 0; fi
for file in ${quotedRoot}/*.js; do
  [ -f "$file" ] || continue
  basename "$file"
done`,
    { cwd, timeout: 10 }
  );
  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Runtime workflow discovery failed: ${details}`);
  }
  return result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function runtimeScratchContentExists(
  runtime: Runtime,
  root: string,
  cwd: string
): Promise<boolean> {
  assert(root.length > 0, "Workflow runtime scratch root is required");
  const quotedRoot = quoteRuntimeProbePath(root);
  const result = await execBuffered(
    runtime,
    `if [ ! -d ${quotedRoot} ]; then exit 0; fi
find ${quotedRoot} -mindepth 1 -maxdepth 1 ! -name .gitignore -print -quit`,
    { cwd, timeout: 5 }
  );
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function deleteRuntimeGeneratedScratchGitignore(
  runtime: Runtime,
  root: string,
  cwd: string
): Promise<boolean> {
  assert(root.length > 0, "Workflow runtime scratch root is required");
  const gitignorePath = runtime.normalizePath(".gitignore", root);
  try {
    if (!(await runtimePathExists(runtime, gitignorePath, cwd))) {
      return false;
    }
    if (await runtimeScratchContentExists(runtime, root, cwd)) {
      return false;
    }
    if (!isGeneratedScratchGitignoreContent(await readFileString(runtime, gitignorePath))) {
      return false;
    }
    const result = await execBuffered(runtime, `rm -f -- ${quoteRuntimeProbePath(gitignorePath)}`, {
      cwd,
      timeout: 5,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function scanRuntimeDirectory(
  runtime: Runtime,
  root: string,
  cwd: string,
  scope: "project" | "scratch"
): Promise<ScannedWorkflowDefinition[]> {
  let entries: string[];
  try {
    entries = await listRuntimeWorkflowFilenames(runtime, root, cwd);
  } catch (error) {
    log.warn(`Skipping runtime workflow root '${root}': ${getErrorMessage(error)}`);
    return [];
  }

  const definitions: ScannedWorkflowDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".js")) {
      continue;
    }

    const rawName = entry.slice(0, -".js".length);
    const nameResult = WorkflowNameSchema.safeParse(rawName);
    if (!nameResult.success) {
      log.warn(`Skipping invalid workflow filename '${entry}' in ${root}`);
      continue;
    }

    const sourcePath = runtime.normalizePath(entry, root);
    let source: string;
    try {
      source = await readFileString(runtime, sourcePath);
    } catch (error) {
      log.warn(`Skipping unreadable runtime workflow '${sourcePath}': ${getErrorMessage(error)}`);
      continue;
    }

    const description = parseWorkflowDescription(source);
    if (description == null) {
      log.warn(`Skipping workflow '${sourcePath}' because it is missing a description header`);
      continue;
    }

    const descriptor = descriptorForFile({
      name: nameResult.data,
      description,
      scope,
      sourcePath,
    });
    if (descriptor == null) {
      continue;
    }

    definitions.push({ descriptor, source });
  }

  return definitions;
}

async function runtimePathExists(
  runtime: Runtime,
  targetPath: string,
  cwd: string
): Promise<boolean> {
  const result = await execBuffered(runtime, `[ -e ${quoteRuntimeProbePath(targetPath)} ]`, {
    cwd,
    timeout: 5,
  });
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  throw new Error(`Runtime workflow path probe failed: ${details}`);
}

const gitExcludeUpdateLocks = new Map<string, Promise<void>>();

function stripTrailingLineEnding(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error == null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function withSerializedGitExcludeUpdate(
  excludePath: string,
  update: () => Promise<void>
): Promise<void> {
  const previous = gitExcludeUpdateLocks.get(excludePath) ?? Promise.resolve();
  let releaseCurrent: (value?: void | PromiseLike<void>) => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  gitExcludeUpdateLocks.set(excludePath, queued);

  await previous.catch(() => undefined);
  try {
    await update();
  } finally {
    releaseCurrent();
    if (gitExcludeUpdateLocks.get(excludePath) === queued) {
      gitExcludeUpdateLocks.delete(excludePath);
    }
  }
}

function escapeGitIgnorePatternSegment(segment: string): string {
  assert(!segment.includes("\0"), "Workflow scratch Git prefix must not contain NUL");
  assert(!/[\r\n]/u.test(segment), "Workflow scratch Git prefix must not contain line separators");
  return segment.replace(/[\\*?[\]]/gu, "\\$&");
}

function scratchGitExcludePatternFromPrefix(prefixOutput: string): string | null {
  const prefix = stripTrailingLineEnding(prefixOutput).replace(/\/+$/u, "");
  if (prefix.length === 0) {
    return null;
  }
  if (/[\r\n]/u.test(prefix)) {
    return null;
  }
  assert(!prefix.startsWith("/"), "Workflow scratch Git prefix must be repo-relative");

  const segments = prefix.split("/").filter((segment) => segment.length > 0);
  assert(segments.length > 0, "Workflow scratch Git prefix must have path segments");
  return `/${segments.map(escapeGitIgnorePatternSegment).join("/")}/`;
}

function scratchGitPrefixForWorkspace(
  workspacePrefixOutput: string,
  scratchRelativePath: string
): string | null {
  const workspacePrefix = stripTrailingLineEnding(workspacePrefixOutput).replace(/\/+$/u, "");
  const scratchRelativePrefix = scratchRelativePath
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/gu, "");
  if (scratchRelativePrefix.length === 0) {
    return null;
  }
  return workspacePrefix.length > 0
    ? `${workspacePrefix}/${scratchRelativePrefix}/`
    : `${scratchRelativePrefix}/`;
}

function gitExcludeContentWithPattern(content: string, pattern: string): string | null {
  assert(pattern.startsWith("/"), "Workflow scratch Git exclude pattern must be root-relative");
  if (content.split(/\r?\n/u).some((line) => line.trim() === pattern)) {
    return null;
  }

  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  return `${content}${separator}${WORKFLOW_SCRATCH_GIT_EXCLUDE_COMMENT}\n${pattern}\n`;
}

function isScratchGitignoreSelfException(pattern: string): boolean {
  return pattern === "!.gitignore" || pattern === "!/.gitignore";
}

function scratchGitignorePatterns(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function isGeneratedScratchGitignoreContent(content: string): boolean {
  const patterns = scratchGitignorePatterns(content);
  const draftPatterns = patterns.filter((pattern) => !isScratchGitignoreSelfException(pattern));
  return (
    draftPatterns.length > 0 &&
    draftPatterns.every((pattern) => pattern === "*") &&
    patterns.every((pattern) => pattern === "*" || isScratchGitignoreSelfException(pattern))
  );
}

function scratchGitignoreFallbackContent(content: string): string | null {
  const lastPattern = scratchGitignorePatterns(content).at(-1);
  if (lastPattern === "*") {
    return null;
  }
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  return `${content}${separator}${WORKFLOW_SCRATCH_GITIGNORE_FALLBACK_COMMENT}\n*\n`;
}

async function writeLocalGitExcludePattern(excludePath: string, pattern: string): Promise<void> {
  assert(excludePath.length > 0, "Workflow scratch Git exclude path is required");
  await withSerializedGitExcludeUpdate(excludePath, async () => {
    await fs.mkdir(path.dirname(excludePath), { recursive: true });

    let content = "";
    try {
      await fs.stat(excludePath);
      content = await fs.readFile(excludePath, "utf-8");
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        log.debug("Skipping scratch workflow Git exclude update after read failure", {
          excludePath,
          error: getErrorMessage(error),
        });
        return;
      }
    }

    const nextContent = gitExcludeContentWithPattern(content, pattern);
    if (nextContent != null) {
      await fs.writeFile(excludePath, nextContent, "utf-8");
    }
  });
}

async function writeLocalScratchGitignoreFallback(scratchRoot: string): Promise<void> {
  await fs.mkdir(scratchRoot, { recursive: true });
  const gitignorePath = path.join(scratchRoot, ".gitignore");
  let content = "";
  try {
    await fs.stat(gitignorePath);
    content = await fs.readFile(gitignorePath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      log.debug("Skipping scratch workflow fallback .gitignore update after read failure", {
        gitignorePath,
        error: getErrorMessage(error),
      });
      return;
    }
  }

  const nextContent = scratchGitignoreFallbackContent(content);
  if (nextContent != null) {
    await fs.writeFile(gitignorePath, nextContent, "utf-8");
  }
}

async function deleteLocalGeneratedScratchGitignore(scratchRoot: string): Promise<boolean> {
  assert(scratchRoot.length > 0, "Workflow scratch root is required");
  const gitignorePath = path.join(scratchRoot, ".gitignore");
  try {
    if (await localScratchContentExists(scratchRoot)) {
      return false;
    }
    const content = await fs.readFile(gitignorePath, "utf-8");
    if (!isGeneratedScratchGitignoreContent(content)) {
      return false;
    }
    await fs.unlink(gitignorePath);
    return true;
  } catch {
    return false;
  }
}

async function tryLocalGitStdout(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    using proc = execFileAsync("git", ["-C", cwd, ...args], {
      timeoutMs: LOCAL_GIT_COMMAND_TIMEOUT_MS,
    });
    const result = await proc.result;
    return stripTrailingLineEnding(result.stdout);
  } catch {
    return null;
  }
}

function getProcessExitCode(error: unknown): number | null {
  if (typeof error !== "object" || error == null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

async function tryLocalGitExitCode(cwd: string, args: readonly string[]): Promise<number | null> {
  try {
    using proc = execFileAsync("git", ["-C", cwd, ...args], {
      timeoutMs: LOCAL_GIT_COMMAND_TIMEOUT_MS,
    });
    await proc.result;
    return 0;
  } catch (error) {
    return getProcessExitCode(error);
  }
}

async function localDirectoryExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function localScratchContentExists(scratchRoot: string): Promise<boolean> {
  assert(scratchRoot.length > 0, "Workflow scratch root is required");
  try {
    const entries = await fs.readdir(scratchRoot);
    return entries.some((entry) => entry !== ".gitignore");
  } catch {
    return false;
  }
}

function localScratchWorkspaceRoot(scratchRoot: string): string {
  return path.dirname(path.dirname(path.dirname(scratchRoot)));
}

function localScratchRelativePath(workspaceRoot: string, scratchRoot: string): string {
  const relativePath = path.relative(workspaceRoot, scratchRoot);
  assert(
    relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath),
    "Workflow scratch root must be under the workspace root"
  );
  return relativePath.split(path.sep).join("/");
}

async function isLocalGitIgnored(cwd: string, targetPath: string): Promise<boolean | null> {
  const exitCode = await tryLocalGitExitCode(cwd, ["check-ignore", "-q", "--", targetPath]);
  if (exitCode === 0) {
    return true;
  }
  if (exitCode === 1) {
    return false;
  }
  return null;
}

// Scratch drafts are workspace-local, but writing .scratch/.gitignore dirties clean repos.
// Prefer repo-local Git excludes; write a self-ignored fallback only when repo rules override them.
async function ensureLocalScratchGitExclude(scratchRoot: string): Promise<void> {
  const workspaceRoot = localScratchWorkspaceRoot(scratchRoot);
  if (!(await localDirectoryExists(workspaceRoot))) {
    return;
  }

  try {
    const workspacePrefix = await tryLocalGitStdout(workspaceRoot, ["rev-parse", "--show-prefix"]);
    if (workspacePrefix == null) {
      return;
    }
    const scratchPrefix = scratchGitPrefixForWorkspace(
      workspacePrefix,
      localScratchRelativePath(workspaceRoot, scratchRoot)
    );
    const pattern =
      scratchPrefix == null ? null : scratchGitExcludePatternFromPrefix(scratchPrefix);
    if (pattern == null) {
      return;
    }

    const excludePath = await tryLocalGitStdout(workspaceRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]);
    if (excludePath == null || excludePath.length === 0) {
      return;
    }

    await writeLocalGitExcludePattern(excludePath, pattern);

    const fallbackProbePath = path.join(scratchRoot, ".gitignore");
    const ignored = await isLocalGitIgnored(workspaceRoot, fallbackProbePath);
    if (ignored === false) {
      await writeLocalScratchGitignoreFallback(scratchRoot);
    }
  } catch (error) {
    log.debug("Failed to install local scratch workflow Git exclude", {
      scratchRoot,
      error: getErrorMessage(error),
    });
  }
}

function runtimeRelativePathUnder(basePath: string, targetPath: string): string | null {
  const normalizedBase = basePath.replace(/\/+$/u, "");
  const normalizedTarget = targetPath.replace(/\/+$/u, "");
  if (normalizedBase === "/") {
    return normalizedTarget.startsWith("/") ? normalizedTarget.slice(1) : null;
  }
  if (normalizedTarget === normalizedBase) {
    return "";
  }
  if (!normalizedTarget.startsWith(`${normalizedBase}/`)) {
    return null;
  }
  return normalizedTarget.slice(normalizedBase.length + 1);
}

async function tryRuntimeGitStdout(
  runtime: Runtime,
  commandCwd: string,
  gitCwd: string,
  args: readonly string[]
): Promise<string | null> {
  const command = `git -C ${quoteRuntimeProbePath(gitCwd)} ${args.map(shellQuote).join(" ")}`;
  const result = await execBuffered(runtime, command, {
    cwd: commandCwd,
    timeout: RUNTIME_GIT_COMMAND_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return stripTrailingLineEnding(result.stdout);
}

async function writeRuntimeGitExcludePattern(
  runtime: Runtime,
  commandCwd: string,
  excludePath: string,
  pattern: string
): Promise<void> {
  assert(excludePath.length > 0, "Workflow scratch runtime Git exclude path is required");
  await withSerializedGitExcludeUpdate(excludePath, async () => {
    await runtime.ensureDir(path.posix.dirname(excludePath));

    let content = "";
    if (await runtimePathExists(runtime, excludePath, commandCwd)) {
      try {
        content = await readFileString(runtime, excludePath);
      } catch (error) {
        log.debug("Skipping runtime scratch workflow Git exclude update after read failure", {
          excludePath,
          error: getErrorMessage(error),
        });
        return;
      }
    }

    const nextContent = gitExcludeContentWithPattern(content, pattern);
    if (nextContent != null) {
      await writeFileString(runtime, excludePath, nextContent);
    }
  });
}

async function writeRuntimeScratchGitignoreFallback(
  runtime: Runtime,
  commandCwd: string,
  scratchRoot: string
): Promise<void> {
  await runtime.ensureDir(scratchRoot);
  const gitignorePath = runtime.normalizePath(".gitignore", scratchRoot);
  let content = "";
  if (await runtimePathExists(runtime, gitignorePath, commandCwd)) {
    try {
      content = await readFileString(runtime, gitignorePath);
    } catch (error) {
      log.debug("Skipping runtime scratch workflow fallback .gitignore update after read failure", {
        gitignorePath,
        error: getErrorMessage(error),
      });
      return;
    }
  }

  const nextContent = scratchGitignoreFallbackContent(content);
  if (nextContent != null) {
    await writeFileString(runtime, gitignorePath, nextContent);
  }
}

async function isRuntimeGitIgnored(
  runtime: Runtime,
  commandCwd: string,
  gitCwd: string,
  targetPath: string
): Promise<boolean | null> {
  const command = `git -C ${quoteRuntimeProbePath(gitCwd)} check-ignore -q -- ${quoteRuntimeProbePath(targetPath)}`;
  const result = await execBuffered(runtime, command, {
    cwd: commandCwd,
    timeout: RUNTIME_GIT_COMMAND_TIMEOUT_SECONDS,
  });
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  return null;
}

async function ensureRuntimeScratchGitExclude(
  runtime: Runtime,
  scratchRoot: string,
  commandCwd: string
): Promise<void> {
  try {
    const workspacePrefix = await tryRuntimeGitStdout(runtime, commandCwd, commandCwd, [
      "rev-parse",
      "--show-prefix",
    ]);
    if (workspacePrefix == null) {
      return;
    }
    const scratchRelativePath = runtimeRelativePathUnder(commandCwd, scratchRoot);
    if (scratchRelativePath == null) {
      return;
    }
    const scratchPrefix = scratchGitPrefixForWorkspace(workspacePrefix, scratchRelativePath);
    const pattern =
      scratchPrefix == null ? null : scratchGitExcludePatternFromPrefix(scratchPrefix);
    if (pattern == null) {
      return;
    }

    const excludePath = await tryRuntimeGitStdout(runtime, commandCwd, commandCwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]);
    if (excludePath == null || excludePath.length === 0) {
      return;
    }

    await writeRuntimeGitExcludePattern(runtime, commandCwd, excludePath, pattern);

    const fallbackProbePath = runtime.normalizePath(".gitignore", scratchRoot);
    const ignored = await isRuntimeGitIgnored(runtime, commandCwd, commandCwd, fallbackProbePath);
    if (ignored === false) {
      await writeRuntimeScratchGitignoreFallback(runtime, commandCwd, scratchRoot);
    }
  } catch (error) {
    log.debug("Failed to install runtime scratch workflow Git exclude", {
      scratchRoot,
      error: getErrorMessage(error),
    });
  }
}

function readBuiltInDefinitions(
  builtIns: readonly BuiltInWorkflowDefinition[]
): ScannedWorkflowDefinition[] {
  const definitions: ScannedWorkflowDefinition[] = [];
  for (const builtIn of builtIns) {
    const descriptor = WorkflowDefinitionDescriptorSchema.parse({
      name: builtIn.name,
      description: builtIn.description,
      scope: "built-in",
      executable: true,
    });
    definitions.push({ descriptor, source: builtIn.source });
  }
  return definitions;
}

function normalizePromotionDescription(description: string): string {
  const normalized = description.replace(/\s+/gu, " ").trim();
  assert(normalized.length > 0, "Workflow promotion description is required");
  return normalized;
}

function withDescriptionHeader(source: string, description: string): string {
  const lines = source.replace(/^\uFEFF/u, "").split("\n");
  const firstMeaningfulIndex = lines.findIndex((line) => line.trim().length > 0);
  if (
    firstMeaningfulIndex >= 0 &&
    lines[firstMeaningfulIndex]?.trim().startsWith(DESCRIPTION_PREFIX)
  ) {
    lines.splice(firstMeaningfulIndex, 1, `${DESCRIPTION_PREFIX} ${description}`);
    return lines.join("\n");
  }
  return `${DESCRIPTION_PREFIX} ${description}\n${source}`;
}

export class WorkflowDefinitionStore {
  private readonly projectRoot: string;
  private readonly globalRoot: string;
  private readonly scratchRoot?: string;
  private readonly projectRuntime?: Runtime;
  private readonly projectCwd?: string;
  private readonly builtIns: readonly BuiltInWorkflowDefinition[];

  constructor(options: WorkflowDefinitionStoreOptions) {
    assert(options.projectRoot.length > 0, "WorkflowDefinitionStore: projectRoot is required");
    assert(options.globalRoot.length > 0, "WorkflowDefinitionStore: globalRoot is required");
    assert(
      options.projectRuntime == null ||
        (options.projectCwd != null && options.projectCwd.length > 0),
      "WorkflowDefinitionStore: projectCwd is required with projectRuntime"
    );

    this.projectRoot = options.projectRoot;
    this.globalRoot = options.globalRoot;
    this.scratchRoot = options.scratchRoot;
    this.projectRuntime = options.projectRuntime;
    this.projectCwd = options.projectCwd;
    this.builtIns = options.builtIns ?? BUILT_IN_WORKFLOW_DEFINITIONS;
  }

  async listDefinitions(options: {
    projectTrusted: boolean;
  }): Promise<WorkflowDefinitionDescriptor[]> {
    const byName = await this.collectDefinitions(options);
    return Array.from(byName.values())
      .map((definition) => definition.descriptor)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async readDefinition(
    name: string,
    options: { projectTrusted: boolean }
  ): Promise<WorkflowDefinitionReadResult> {
    const parsedName = WorkflowNameSchema.parse(name);
    const byName = await this.collectDefinitions(options);
    const definition = byName.get(parsedName);
    if (definition == null) {
      throw new Error(`Workflow definition not found: ${parsedName}`);
    }
    return {
      descriptor: definition.descriptor,
      source: definition.source,
    };
  }

  async promoteDefinition(
    input: PromoteWorkflowDefinitionInput
  ): Promise<WorkflowDefinitionDescriptor> {
    const name = WorkflowNameSchema.parse(input.name);
    const description = normalizePromotionDescription(input.description);
    assert(
      input.source.trim().length > 0,
      "WorkflowDefinitionStore.promoteDefinition: source is required"
    );
    if (input.location === "project" && !input.projectTrusted) {
      throw new Error("Project trust is required to promote project-local workflows");
    }

    const root = input.location === "project" ? this.projectRoot : this.globalRoot;
    const sourcePath =
      this.projectRuntime?.normalizePath(`${name}.js`, root) ?? path.join(root, `${name}.js`);
    const promotedSource = withDescriptionHeader(input.source, description);
    if (input.location === "project" && this.projectRuntime != null) {
      assert(
        this.projectCwd != null,
        "WorkflowDefinitionStore.promoteDefinition: projectCwd missing"
      );
      await this.projectRuntime.ensureDir(root);
      if (
        !input.overwrite &&
        (await runtimePathExists(this.projectRuntime, sourcePath, this.projectCwd))
      ) {
        throw new Error(`Workflow definition already exists: ${sourcePath}`);
      }
      await writeFileString(this.projectRuntime, sourcePath, promotedSource);
    } else {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(sourcePath, promotedSource, {
        encoding: "utf-8",
        flag: input.overwrite ? "w" : "wx",
      });
    }

    const descriptor = descriptorForFile({
      name,
      description,
      scope: input.location,
      sourcePath,
    });
    assert(
      descriptor != null,
      "WorkflowDefinitionStore.promoteDefinition: descriptor must be valid"
    );
    return descriptor;
  }

  private async collectDefinitions(options: {
    projectTrusted: boolean;
  }): Promise<Map<WorkflowName, ScannedWorkflowDefinition>> {
    const byName = new Map<WorkflowName, ScannedWorkflowDefinition>();
    const sources: ScannedWorkflowDefinition[][] = [];

    if (this.scratchRoot != null && options.projectTrusted) {
      // Scratch workflows live under the workspace checkout, so treat them like project-local
      // code for trust gating rather than exposing repo-controlled files from untrusted projects.
      // Keep plain workflow discovery read-only: only create/touch scratch ignore files once
      // there is an actual scratch workflow candidate for Git to hide.
      if (this.projectRuntime != null) {
        assert(
          this.projectCwd != null,
          "WorkflowDefinitionStore.collectDefinitions: projectCwd missing"
        );
        const scratchDefinitions = await scanRuntimeDirectory(
          this.projectRuntime,
          this.scratchRoot,
          this.projectCwd,
          "scratch"
        );
        const hasScratchContent =
          scratchDefinitions.length > 0 ||
          (await runtimeScratchContentExists(
            this.projectRuntime,
            this.scratchRoot,
            this.projectCwd
          ));
        if (hasScratchContent) {
          await ensureRuntimeScratchGitExclude(
            this.projectRuntime,
            this.scratchRoot,
            this.projectCwd
          );
        } else {
          // Older eager versions may have left only the generated fallback behind;
          // delete that stale file so upgrade returns the checkout to clean.
          await deleteRuntimeGeneratedScratchGitignore(
            this.projectRuntime,
            this.scratchRoot,
            this.projectCwd
          );
        }
        sources.push(scratchDefinitions);
      } else {
        const scratchDefinitions = await scanDirectory(this.scratchRoot, "scratch");
        const hasScratchContent =
          scratchDefinitions.length > 0 || (await localScratchContentExists(this.scratchRoot));
        if (hasScratchContent) {
          await ensureLocalScratchGitExclude(this.scratchRoot);
        } else {
          // Older eager versions may have left only the generated fallback behind;
          // delete that stale file so upgrade returns the checkout to clean.
          await deleteLocalGeneratedScratchGitignore(this.scratchRoot);
        }
        sources.push(scratchDefinitions);
      }
    }
    if (options.projectTrusted) {
      if (this.projectRuntime != null) {
        assert(
          this.projectCwd != null,
          "WorkflowDefinitionStore.collectDefinitions: projectCwd missing"
        );
        sources.push(
          await scanRuntimeDirectory(
            this.projectRuntime,
            this.projectRoot,
            this.projectCwd,
            "project"
          )
        );
      } else {
        sources.push(await scanDirectory(this.projectRoot, "project"));
      }
    }
    sources.push(await scanDirectory(this.globalRoot, "global"));
    sources.push(readBuiltInDefinitions(this.builtIns));

    for (const source of sources) {
      for (const definition of source) {
        if (!byName.has(definition.descriptor.name)) {
          byName.set(definition.descriptor.name, definition);
        }
      }
    }

    return byName;
  }
}
