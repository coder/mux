import * as path from "path";
import * as jsonc from "jsonc-parser";

import assert from "@/common/utils/assert";
import type {
  HarnessChecklistItem,
  HarnessChecklistStatus,
  HarnessLoopSettings,
  HarnessLoopState,
  WorkspaceHarnessConfig,
  WorkspaceHarnessFilePaths,
} from "@/common/types/harness";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { log } from "@/node/services/log";

const HARNESS_DIR = ".mux/harness";

const HARNESS_GITIGNORE_PATTERNS = [
  `${HARNESS_DIR}/*.harness.jsonc`,
  `${HARNESS_DIR}/*.harness.progress.md`,
];

const DEFAULT_LOOP_SETTINGS: Required<
  Pick<
    HarnessLoopSettings,
    | "maxIterations"
    | "maxWallTimeMins"
    | "maxConsecutiveFailures"
    | "contextReset"
    | "autoCommit"
    | "commitMessageTemplate"
  >
> & { toolPolicy?: ToolPolicy } = {
  maxIterations: 50,
  maxWallTimeMins: 8 * 60,
  maxConsecutiveFailures: 3,
  contextReset: "replace_history",
  autoCommit: true,
  commitMessageTemplate: "mux(harness): {{item}}",
};

const DEFAULT_HARNESS_CONFIG: WorkspaceHarnessConfig = {
  version: 1,
  checklist: [],
  gates: [],
  loop: { ...DEFAULT_LOOP_SETTINGS },
};

function joinForRuntime(runtimeConfig: RuntimeConfig | undefined, ...parts: string[]): string {
  assert(parts.length > 0, "joinForRuntime requires at least one path segment");

  // Remote runtimes run inside a POSIX shell (SSH host, Docker container), even if the user is
  // running mux on Windows. Use POSIX joins so we don't accidentally introduce backslashes.
  const usePosix = runtimeConfig?.type === "ssh" || runtimeConfig?.type === "docker";
  return usePosix ? path.posix.join(...parts) : path.join(...parts);
}

function isAbsoluteForRuntime(runtimeConfig: RuntimeConfig | undefined, filePath: string): boolean {
  const usePosix = runtimeConfig?.type === "ssh" || runtimeConfig?.type === "docker";
  return usePosix ? path.posix.isAbsolute(filePath) : path.isAbsolute(filePath);
}

function isChecklistStatus(value: unknown): value is HarnessChecklistStatus {
  return value === "todo" || value === "doing" || value === "done" || value === "blocked";
}

function clampPositiveInt(
  value: unknown,
  fallback: number,
  { min, max }: { min: number; max: number }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalizeChecklistItem(raw: unknown, index: number): HarnessChecklistItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (title.length === 0) {
    return null;
  }

  const status = isChecklistStatus(obj.status) ? obj.status : ("todo" as const);

  const idRaw = typeof obj.id === "string" ? obj.id.trim() : "";
  const id = idRaw.length > 0 ? idRaw : `item-${index + 1}`;

  const notes =
    typeof obj.notes === "string" && obj.notes.trim().length > 0 ? obj.notes.trim() : undefined;

  return { id, title, status, notes };
}

function normalizeWorkspaceHarnessConfig(raw: unknown): WorkspaceHarnessConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_HARNESS_CONFIG };
  }

  const obj = raw as Record<string, unknown>;

  const checklist: HarnessChecklistItem[] = [];
  if (Array.isArray(obj.checklist)) {
    for (const [index, entry] of obj.checklist.entries()) {
      const normalized = normalizeChecklistItem(entry, index);
      if (normalized) {
        checklist.push(normalized);
      }
    }
  }

  const gates = Array.isArray(obj.gates)
    ? obj.gates
        .map((g) => {
          if (!g || typeof g !== "object") return null;
          const gate = g as Record<string, unknown>;
          const command = typeof gate.command === "string" ? gate.command.trim() : "";
          if (command.length === 0) return null;

          const id =
            typeof gate.id === "string" && gate.id.trim().length > 0 ? gate.id.trim() : undefined;
          const title =
            typeof gate.title === "string" && gate.title.trim().length > 0
              ? gate.title.trim()
              : undefined;
          const timeoutSecs =
            typeof gate.timeoutSecs === "number" &&
            Number.isFinite(gate.timeoutSecs) &&
            gate.timeoutSecs > 0
              ? Math.floor(gate.timeoutSecs)
              : undefined;

          return { id, title, command, timeoutSecs };
        })
        .filter((g): g is NonNullable<typeof g> => g !== null)
    : [];

  const loopRaw =
    obj.loop && typeof obj.loop === "object" ? (obj.loop as Record<string, unknown>) : {};

  const loop: HarnessLoopSettings = {
    maxIterations: clampPositiveInt(loopRaw.maxIterations, DEFAULT_LOOP_SETTINGS.maxIterations, {
      min: 1,
      max: 1000,
    }),
    maxWallTimeMins: clampPositiveInt(
      loopRaw.maxWallTimeMins,
      DEFAULT_LOOP_SETTINGS.maxWallTimeMins,
      {
        min: 1,
        max: 7 * 24 * 60,
      }
    ),
    maxConsecutiveFailures: clampPositiveInt(
      loopRaw.maxConsecutiveFailures,
      DEFAULT_LOOP_SETTINGS.maxConsecutiveFailures,
      { min: 1, max: 50 }
    ),
    contextReset:
      loopRaw.contextReset === "none" || loopRaw.contextReset === "replace_history"
        ? loopRaw.contextReset
        : DEFAULT_LOOP_SETTINGS.contextReset,
    autoCommit:
      typeof loopRaw.autoCommit === "boolean"
        ? loopRaw.autoCommit
        : DEFAULT_LOOP_SETTINGS.autoCommit,
    commitMessageTemplate:
      typeof loopRaw.commitMessageTemplate === "string" &&
      loopRaw.commitMessageTemplate.trim().length > 0
        ? loopRaw.commitMessageTemplate.trim()
        : DEFAULT_LOOP_SETTINGS.commitMessageTemplate,
    toolPolicy: Array.isArray(loopRaw.toolPolicy) ? (loopRaw.toolPolicy as ToolPolicy) : undefined,
  };

  const normalized: WorkspaceHarnessConfig = {
    version: 1,
    checklist,
    gates,
    loop,
  };

  return normalized;
}

async function statIsFile(
  runtime: ReturnType<typeof createRuntime>,
  filePath: string
): Promise<boolean> {
  try {
    const stat = await runtime.stat(filePath);
    return !stat.isDirectory;
  } catch {
    return false;
  }
}

function formatChecklistItemForProgress(item: HarnessChecklistItem): string {
  const checkbox =
    item.status === "done"
      ? "[x]"
      : item.status === "doing"
        ? "[~]"
        : item.status === "blocked"
          ? "[!]"
          : "[ ]";
  return `- ${checkbox} ${item.title}`;
}

function renderProgressMarkdown(params: {
  metadata: FrontendWorkspaceMetadata;
  config: WorkspaceHarnessConfig;
  paths: WorkspaceHarnessFilePaths;
  loopState?: HarnessLoopState;
}): string {
  const nowIso = new Date().toISOString();

  const lines: string[] = [];
  lines.push(`# Harness Progress`);
  lines.push("");
  lines.push(`- Workspace: ${params.metadata.name} (${params.metadata.id})`);
  lines.push(`- Updated: ${nowIso}`);
  lines.push(`- Harness file: ${params.paths.configPath}`);
  lines.push("");

  lines.push("## Checklist");
  if (params.config.checklist.length === 0) {
    lines.push("(no checklist items)");
  } else {
    for (const item of params.config.checklist) {
      lines.push(formatChecklistItemForProgress(item));
    }
  }
  lines.push("");

  lines.push("## Gates");
  if (params.config.gates.length === 0) {
    lines.push("(no gates configured)");
  } else {
    for (const gate of params.config.gates) {
      lines.push(`- ${gate.command}`);
    }
  }
  lines.push("");

  if (params.loopState) {
    lines.push("## Loop");
    lines.push(`- Status: ${params.loopState.status}`);
    lines.push(`- Iteration: ${params.loopState.iteration}`);
    if (params.loopState.currentItemTitle) {
      lines.push(`- Current item: ${params.loopState.currentItemTitle}`);
    }
    if (params.loopState.lastGateRun) {
      lines.push(
        `- Last gates: ${params.loopState.lastGateRun.ok ? "PASS" : "FAIL"} (${Math.round(
          params.loopState.lastGateRun.totalDurationMs / 1000
        )}s)`
      );
    }
    if (params.loopState.lastCheckpoint?.commitSha) {
      lines.push(`- Last commit: ${params.loopState.lastCheckpoint.commitSha}`);
    }
    if (params.loopState.lastError) {
      lines.push(`- Last error: ${params.loopState.lastError}`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

export class WorkspaceHarnessService {
  constructor(private readonly config: Config) {
    assert(config, "WorkspaceHarnessService requires a Config instance");
  }

  private async getWorkspaceMetadata(workspaceId: string): Promise<FrontendWorkspaceMetadata> {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    const all = await this.config.getAllWorkspaceMetadata();
    const metadata = all.find((m) => m.id === trimmed);
    if (!metadata) {
      throw new Error(`Workspace metadata not found for ${trimmed}`);
    }

    return metadata;
  }

  async getRuntimeAndWorkspacePath(workspaceId: string): Promise<{
    metadata: FrontendWorkspaceMetadata;
    runtime: ReturnType<typeof createRuntime>;
    workspacePath: string;
  }> {
    const metadata = await this.getWorkspaceMetadata(workspaceId);

    const runtime = createRuntime(
      metadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir },
      { projectPath: metadata.projectPath }
    );

    // In-place workspaces (CLI/benchmarks) store the workspace path directly by setting
    // metadata.projectPath === metadata.name.
    const isInPlace = metadata.projectPath === metadata.name;
    const workspacePath = isInPlace
      ? metadata.projectPath
      : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

    assert(
      typeof workspacePath === "string" && workspacePath.length > 0,
      "workspacePath is required"
    );

    return { metadata, runtime, workspacePath };
  }

  private getHarnessFilePaths(
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined,
    workspaceName: string
  ): WorkspaceHarnessFilePaths {
    assert(typeof workspacePath === "string", "workspacePath must be a string");
    assert(typeof workspaceName === "string", "workspaceName must be a string");

    const prefix = workspaceName.trim().length > 0 ? workspaceName.trim() : "workspace";

    return {
      configPath: joinForRuntime(
        runtimeConfig,
        workspacePath,
        HARNESS_DIR,
        `${prefix}.harness.jsonc`
      ),
      progressPath: joinForRuntime(
        runtimeConfig,
        workspacePath,
        HARNESS_DIR,
        `${prefix}.harness.progress.md`
      ),
    };
  }

  private async readHarnessFile(
    runtime: ReturnType<typeof createRuntime>,
    filePath: string
  ): Promise<unknown> {
    try {
      const raw = await readFileString(runtime, filePath);
      const errors: jsonc.ParseError[] = [];
      const parsed: unknown = jsonc.parse(raw, errors) as unknown;
      if (errors.length > 0) {
        log.warn("[HARNESS] Failed to parse harness config (JSONC parse errors)", {
          filePath,
          errorCount: errors.length,
        });
        return {};
      }
      return parsed;
    } catch (error) {
      log.debug("[HARNESS] Failed to read harness config file", { filePath, error });
      return {};
    }
  }

  private async ensureHarnessDir(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined
  ): Promise<void> {
    const harnessDirPath = joinForRuntime(runtimeConfig, workspacePath, HARNESS_DIR);

    try {
      await runtime.ensureDir(harnessDirPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create ${HARNESS_DIR} directory: ${msg}`);
    }
  }

  private async ensureHarnessGitignored(
    runtime: ReturnType<typeof createRuntime>,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined
  ): Promise<void> {
    try {
      const isInsideGitResult = await execBuffered(runtime, "git rev-parse --is-inside-work-tree", {
        cwd: workspacePath,
        timeout: 10,
      });
      if (isInsideGitResult.exitCode !== 0 || isInsideGitResult.stdout.trim() !== "true") {
        return;
      }

      const excludePathResult = await execBuffered(
        runtime,
        "git rev-parse --git-path info/exclude",
        {
          cwd: workspacePath,
          timeout: 10,
        }
      );
      if (excludePathResult.exitCode !== 0) {
        return;
      }

      const excludeFilePathRaw = excludePathResult.stdout.trim();
      if (excludeFilePathRaw.length === 0) {
        return;
      }

      const excludeFilePath = isAbsoluteForRuntime(runtimeConfig, excludeFilePathRaw)
        ? excludeFilePathRaw
        : joinForRuntime(runtimeConfig, workspacePath, excludeFilePathRaw);

      let existing = "";
      try {
        existing = await readFileString(runtime, excludeFilePath);
      } catch {
        // Missing exclude file is OK.
      }

      const existingPatterns = new Set(
        existing
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      );
      const missingPatterns = HARNESS_GITIGNORE_PATTERNS.filter(
        (pattern) => !existingPatterns.has(pattern)
      );
      if (missingPatterns.length === 0) {
        return;
      }

      const needsNewline = existing.length > 0 && !existing.endsWith("\n");
      const updated = existing + (needsNewline ? "\n" : "") + missingPatterns.join("\n") + "\n";

      await writeFileString(runtime, excludeFilePath, updated);
    } catch (error) {
      // Best-effort only; never fail a workspace operation because git exclude couldn't be updated.
      log.debug("[HARNESS] Failed to add harness files to git exclude", {
        workspacePath,
        error,
      });
    }
  }

  async getHarnessForWorkspace(workspaceId: string): Promise<{
    config: WorkspaceHarnessConfig;
    paths: WorkspaceHarnessFilePaths;
    exists: boolean;
  }> {
    const { metadata, runtime, workspacePath } = await this.getRuntimeAndWorkspacePath(workspaceId);
    const paths = this.getHarnessFilePaths(workspacePath, metadata.runtimeConfig, metadata.name);

    const exists = await statIsFile(runtime, paths.configPath);
    if (!exists) {
      return { config: { ...DEFAULT_HARNESS_CONFIG }, paths, exists: false };
    }

    const parsed = await this.readHarnessFile(runtime, paths.configPath);
    return {
      config: normalizeWorkspaceHarnessConfig(parsed),
      paths,
      exists: true,
    };
  }

  async setHarnessForWorkspace(
    workspaceId: string,
    config: WorkspaceHarnessConfig,
    options?: { loopState?: HarnessLoopState }
  ): Promise<WorkspaceHarnessConfig> {
    assert(config && typeof config === "object", "config must be an object");

    const { metadata, runtime, workspacePath } = await this.getRuntimeAndWorkspacePath(workspaceId);
    const paths = this.getHarnessFilePaths(workspacePath, metadata.runtimeConfig, metadata.name);

    const normalized = normalizeWorkspaceHarnessConfig(config);

    await this.ensureHarnessDir(runtime, workspacePath, metadata.runtimeConfig);

    await writeFileString(runtime, paths.configPath, JSON.stringify(normalized, null, 2) + "\n");
    await this.ensureHarnessGitignored(runtime, workspacePath, metadata.runtimeConfig);

    // Best-effort: keep the progress file up-to-date for both users and agent context.
    try {
      const progressMarkdown = renderProgressMarkdown({
        metadata,
        config: normalized,
        paths,
        loopState: options?.loopState,
      });
      await writeFileString(runtime, paths.progressPath, progressMarkdown);
    } catch (error) {
      log.debug("[HARNESS] Failed to update harness progress file", { workspaceId, error });
    }

    return normalized;
  }

  async updateProgressFile(workspaceId: string, loopState?: HarnessLoopState): Promise<void> {
    try {
      const { metadata, runtime, workspacePath } =
        await this.getRuntimeAndWorkspacePath(workspaceId);
      const { config, paths } = await this.getHarnessForWorkspace(workspaceId);

      await this.ensureHarnessDir(runtime, workspacePath, metadata.runtimeConfig);
      const progressMarkdown = renderProgressMarkdown({ metadata, config, paths, loopState });
      await writeFileString(runtime, paths.progressPath, progressMarkdown);
    } catch (error) {
      log.debug("[HARNESS] Failed to update progress file", { workspaceId, error });
    }
  }
}
