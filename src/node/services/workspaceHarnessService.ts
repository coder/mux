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

const HARNESS_GITIGNORE_PATTERNS = [`${HARNESS_DIR}/*.jsonc`, `${HARNESS_DIR}/*.progress.md`];

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

function renderHarnessJournalBootstrapMarkdown(params: {
  metadata: FrontendWorkspaceMetadata;
  paths: WorkspaceHarnessFilePaths;
}): string {
  const nowIso = new Date().toISOString();

  const configBasename = path.basename(params.paths.configPath);

  const lines: string[] = [];
  lines.push("# Harness journal (append-only)");
  lines.push("");
  lines.push("This file is an append-only journal for Ralph loop work in this workspace.");
  lines.push("Append new entries at the bottom. Do not edit or rewrite older entries.");
  lines.push("");
  lines.push(`- Workspace: ${params.metadata.name} (${params.metadata.id})`);
  lines.push(`- Created: ${nowIso}`);
  lines.push(`- Harness config: ${path.posix.join(HARNESS_DIR, configBasename)}`);
  lines.push("");
  lines.push("## Entry template");
  lines.push("");
  lines.push("### <ISO timestamp> — Iteration N — Item: <id> — <title>");
  lines.push("- Did:");
  lines.push("- Tried:");
  lines.push("- Learned:");
  lines.push("- Dead ends:");
  lines.push("- Next:");
  lines.push("");
  return lines.join("\n");
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

  private getLegacyHarnessFilePaths(
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
  private getHarnessFilePaths(
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined,
    workspaceName: string
  ): WorkspaceHarnessFilePaths {
    assert(typeof workspacePath === "string", "workspacePath must be a string");
    assert(typeof workspaceName === "string", "workspaceName must be a string");

    const prefix = workspaceName.trim().length > 0 ? workspaceName.trim() : "workspace";

    return {
      configPath: joinForRuntime(runtimeConfig, workspacePath, HARNESS_DIR, `${prefix}.jsonc`),
      progressPath: joinForRuntime(
        runtimeConfig,
        workspacePath,
        HARNESS_DIR,
        `${prefix}.progress.md`
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

  private async ensureHarnessJournalExists(params: {
    metadata: FrontendWorkspaceMetadata;
    runtime: ReturnType<typeof createRuntime>;
    workspacePath: string;
    runtimeConfig: RuntimeConfig | undefined;
    paths: WorkspaceHarnessFilePaths;
    legacyPaths: WorkspaceHarnessFilePaths;
  }): Promise<void> {
    try {
      await this.ensureHarnessDir(params.runtime, params.workspacePath, params.runtimeConfig);

      const exists = await statIsFile(params.runtime, params.paths.progressPath);
      if (exists) {
        return;
      }

      let legacyProgressContents = "";
      const legacyExists = await statIsFile(params.runtime, params.legacyPaths.progressPath);
      if (legacyExists) {
        try {
          legacyProgressContents = await readFileString(
            params.runtime,
            params.legacyPaths.progressPath
          );
        } catch (error) {
          log.debug("[HARNESS] Failed to read legacy harness progress file", {
            filePath: params.legacyPaths.progressPath,
            error,
          });
        }
      }

      let markdown = renderHarnessJournalBootstrapMarkdown({
        metadata: params.metadata,
        paths: params.paths,
      });

      if (legacyProgressContents.trim().length > 0) {
        markdown +=
          "\n## Migrated content (legacy progress file)\n\n" +
          legacyProgressContents.trimEnd() +
          "\n";
      }

      await writeFileString(
        params.runtime,
        params.paths.progressPath,
        markdown.endsWith("\n") ? markdown : `${markdown}\n`
      );
      await this.ensureHarnessGitignored(
        params.runtime,
        params.workspacePath,
        params.runtimeConfig
      );
    } catch (error) {
      log.debug("[HARNESS] Failed to ensure harness journal file exists", {
        workspacePath: params.workspacePath,
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
    const legacyPaths = this.getLegacyHarnessFilePaths(
      workspacePath,
      metadata.runtimeConfig,
      metadata.name
    );

    let exists = await statIsFile(runtime, paths.configPath);
    if (!exists) {
      const legacyExists = await statIsFile(runtime, legacyPaths.configPath);
      if (legacyExists) {
        try {
          const rawLegacy = await readFileString(runtime, legacyPaths.configPath);
          await this.ensureHarnessDir(runtime, workspacePath, metadata.runtimeConfig);
          await writeFileString(
            runtime,
            paths.configPath,
            rawLegacy.endsWith("\n") ? rawLegacy : `${rawLegacy}\n`
          );
          await this.ensureHarnessGitignored(runtime, workspacePath, metadata.runtimeConfig);
          exists = true;
        } catch (error) {
          log.debug("[HARNESS] Failed to migrate legacy harness config file", {
            workspaceId,
            error,
          });
          const parsedLegacy = await this.readHarnessFile(runtime, legacyPaths.configPath);
          return {
            config: normalizeWorkspaceHarnessConfig(parsedLegacy),
            paths: legacyPaths,
            exists: true,
          };
        }
      }
    }

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
    config: WorkspaceHarnessConfig
  ): Promise<WorkspaceHarnessConfig> {
    assert(config && typeof config === "object", "config must be an object");

    const { metadata, runtime, workspacePath } = await this.getRuntimeAndWorkspacePath(workspaceId);
    const paths = this.getHarnessFilePaths(workspacePath, metadata.runtimeConfig, metadata.name);
    const legacyPaths = this.getLegacyHarnessFilePaths(
      workspacePath,
      metadata.runtimeConfig,
      metadata.name
    );

    const normalized = normalizeWorkspaceHarnessConfig(config);
    const serialized = JSON.stringify(normalized, null, 2) + "\n";

    await this.ensureHarnessDir(runtime, workspacePath, metadata.runtimeConfig);

    await writeFileString(runtime, paths.configPath, serialized);
    await this.ensureHarnessGitignored(runtime, workspacePath, metadata.runtimeConfig);

    // Best-effort: keep the legacy file updated for downgrade compatibility.
    try {
      const legacyExists = await statIsFile(runtime, legacyPaths.configPath);
      if (legacyExists) {
        await writeFileString(runtime, legacyPaths.configPath, serialized);
      }
    } catch (error) {
      log.debug("[HARNESS] Failed to update legacy harness config file", { workspaceId, error });
    }

    await this.ensureHarnessJournalExists({
      metadata,
      runtime,
      workspacePath,
      runtimeConfig: metadata.runtimeConfig,
      paths,
      legacyPaths,
    });

    return normalized;
  }

  async updateProgressFile(workspaceId: string, _loopState?: HarnessLoopState): Promise<void> {
    try {
      const { metadata, runtime, workspacePath } =
        await this.getRuntimeAndWorkspacePath(workspaceId);

      const paths = this.getHarnessFilePaths(workspacePath, metadata.runtimeConfig, metadata.name);
      const legacyPaths = this.getLegacyHarnessFilePaths(
        workspacePath,
        metadata.runtimeConfig,
        metadata.name
      );

      await this.ensureHarnessJournalExists({
        metadata,
        runtime,
        workspacePath,
        runtimeConfig: metadata.runtimeConfig,
        paths,
        legacyPaths,
      });
    } catch (error) {
      log.debug("[HARNESS] Failed to ensure harness journal exists", { workspaceId, error });
    }
  }
}
