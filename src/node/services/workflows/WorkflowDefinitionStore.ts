import * as fs from "node:fs/promises";
import * as path from "node:path";

import { WorkflowDefinitionDescriptorSchema, WorkflowNameSchema } from "@/common/orpc/schemas";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import type { WorkflowDefinitionDescriptor, WorkflowName } from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { quoteRuntimeProbePath } from "@/node/services/tools/runtimePathShellQuote";
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
// Workspace scratch workflows are edited through normal file tools, so keep generated drafts out
// of the user's git status while leaving the ignore rule itself visible and reviewable.
export const WORKFLOW_SCRATCH_GITIGNORE_CONTENT = "*\n!.gitignore\n";

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

async function ensureLocalScratchGitignore(scratchRoot: string): Promise<void> {
  await fs.mkdir(scratchRoot, { recursive: true });
  const gitignorePath = path.join(scratchRoot, ".gitignore");
  await fs.writeFile(gitignorePath, WORKFLOW_SCRATCH_GITIGNORE_CONTENT, "utf-8");
}

async function ensureRuntimeScratchGitignore(runtime: Runtime, scratchRoot: string): Promise<void> {
  await runtime.ensureDir(scratchRoot);
  await writeFileString(
    runtime,
    runtime.normalizePath(".gitignore", scratchRoot),
    WORKFLOW_SCRATCH_GITIGNORE_CONTENT
  );
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
      if (this.projectRuntime != null) {
        assert(
          this.projectCwd != null,
          "WorkflowDefinitionStore.collectDefinitions: projectCwd missing"
        );
        await ensureRuntimeScratchGitignore(this.projectRuntime, this.scratchRoot);
        sources.push(
          await scanRuntimeDirectory(
            this.projectRuntime,
            this.scratchRoot,
            this.projectCwd,
            "scratch"
          )
        );
      } else {
        await ensureLocalScratchGitignore(this.scratchRoot);
        sources.push(await scanDirectory(this.scratchRoot, "scratch"));
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
