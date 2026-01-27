import * as fsPromises from "fs/promises";
import * as path from "path";

import assert from "@/common/utils/assert";
import { shellQuote } from "@/common/utils/shell";
import { Ok, Err, type Result } from "@/common/types/result";
import type { GitCheckpointResult } from "@/common/types/harness";
import { GitCheckpointResultSchema } from "@/common/orpc/schemas";
import type { Config } from "@/node/config";
import type { WorkspaceHarnessService } from "@/node/services/workspaceHarnessService";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { log } from "@/node/services/log";

const LAST_CHECKPOINT_FILENAME = "harness-last-checkpoint.json";

// Keep stdout/stderr small enough to store in session state.
const MAX_LOG_CHARS = 50_000;

function truncateLog(value: string): string {
  if (value.length <= MAX_LOG_CHARS) return value;
  return value.slice(-MAX_LOG_CHARS);
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, keyRaw: string) => {
    const key = keyRaw.trim();
    return vars[key] ?? "";
  });
}

export class GitCheckpointService {
  constructor(
    private readonly config: Config,
    private readonly workspaceHarnessService: WorkspaceHarnessService
  ) {
    assert(config, "GitCheckpointService requires a Config instance");
    assert(
      workspaceHarnessService,
      "GitCheckpointService requires a WorkspaceHarnessService instance"
    );
  }

  private getLastCheckpointPath(workspaceId: string): string {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");
    return path.join(this.config.sessionsDir, trimmed, LAST_CHECKPOINT_FILENAME);
  }

  async getLastCheckpoint(workspaceId: string): Promise<GitCheckpointResult | null> {
    const filePath = this.getLastCheckpointPath(workspaceId);

    try {
      const raw = await fsPromises.readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw) as unknown;
      const result = GitCheckpointResultSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private async persistLastCheckpoint(
    workspaceId: string,
    result: GitCheckpointResult
  ): Promise<void> {
    const filePath = this.getLastCheckpointPath(workspaceId);
    const dir = path.dirname(filePath);

    try {
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(filePath, JSON.stringify(result, null, 2) + "\n", "utf-8");
    } catch (error) {
      log.debug("[HARNESS] Failed to persist last checkpoint", { workspaceId, error });
    }
  }

  async checkpoint(
    workspaceId: string,
    options: { messageTemplate: string; itemTitle?: string; iteration?: number }
  ): Promise<Result<GitCheckpointResult>> {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    assert(options && typeof options === "object", "options is required");
    assert(typeof options.messageTemplate === "string", "messageTemplate must be a string");

    const { runtime, workspacePath } =
      await this.workspaceHarnessService.getRuntimeAndWorkspacePath(workspaceId);

    const readyResult = await runtime.ensureReady();
    if (!readyResult.ready) {
      const msg = readyResult.error ?? "Runtime not ready";
      return Err(msg);
    }

    const statusBefore = await execBuffered(runtime, "git status --porcelain", {
      cwd: workspacePath,
      timeout: 30,
    });

    const dirtyBefore = statusBefore.exitCode === 0 && statusBefore.stdout.trim().length > 0;

    if (!dirtyBefore) {
      const res: GitCheckpointResult = {
        committed: false,
        dirtyBefore: false,
        dirtyAfter: false,
        commitSha: null,
        commitMessage: null,
      };
      await this.persistLastCheckpoint(workspaceId, res);
      return Ok(res);
    }

    const messageRaw = renderTemplate(options.messageTemplate, {
      item: options.itemTitle ?? "(no item)",
      iteration: options.iteration !== undefined ? String(options.iteration) : "",
      workspaceId,
    }).trim();

    const message = messageRaw.length > 0 ? messageRaw : "mux(harness): checkpoint";

    const addResult = await execBuffered(runtime, "git add -A", {
      cwd: workspacePath,
      timeout: 60,
    });

    if (addResult.exitCode !== 0) {
      return Err(truncateLog(addResult.stderr || addResult.stdout || "git add -A failed"));
    }

    // Use shellQuote to keep the commit message stable across runtimes.
    const commitResult = await execBuffered(runtime, `git commit -m ${shellQuote(message)}`, {
      cwd: workspacePath,
      timeout: 120,
    });

    if (commitResult.exitCode !== 0) {
      return Err(truncateLog(commitResult.stderr || commitResult.stdout || "git commit failed"));
    }

    const shaResult = await execBuffered(runtime, "git rev-parse HEAD", {
      cwd: workspacePath,
      timeout: 30,
    });

    const commitSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : "";

    const statusAfter = await execBuffered(runtime, "git status --porcelain", {
      cwd: workspacePath,
      timeout: 30,
    });

    const dirtyAfter = statusAfter.exitCode === 0 && statusAfter.stdout.trim().length > 0;

    const res: GitCheckpointResult = {
      committed: true,
      dirtyBefore,
      dirtyAfter,
      commitSha: commitSha.length > 0 ? commitSha : null,
      commitMessage: message,
      stdout: truncateLog(commitResult.stdout).trim() || undefined,
      stderr: truncateLog(commitResult.stderr).trim() || undefined,
    };

    await this.persistLastCheckpoint(workspaceId, res);

    return Ok(res);
  }
}
