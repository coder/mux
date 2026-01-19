import * as fsPromises from "fs/promises";
import * as path from "path";

import assert from "@/common/utils/assert";
import { Ok, Err, type Result } from "@/common/types/result";
import type { HarnessGate, HarnessGateRunResult } from "@/common/types/harness";
import { HarnessGateRunResultSchema } from "@/common/orpc/schemas";
import type { Config } from "@/node/config";
import type { WorkspaceHarnessService } from "@/node/services/workspaceHarnessService";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { log } from "@/node/services/log";

const LAST_GATES_FILENAME = "harness-last-gates.json";

// Keep logs reasonably small for IPC and persisted state. This is only for UI display.
const MAX_OUTPUT_CHARS = 100_000;

function truncateOutput(value: string): { output: string; truncated: boolean } {
  if (value.length <= MAX_OUTPUT_CHARS) {
    return { output: value, truncated: false };
  }
  return { output: value.slice(-MAX_OUTPUT_CHARS), truncated: true };
}

export class GateRunnerService {
  constructor(
    private readonly config: Config,
    private readonly workspaceHarnessService: WorkspaceHarnessService
  ) {
    assert(config, "GateRunnerService requires a Config instance");
    assert(
      workspaceHarnessService,
      "GateRunnerService requires a WorkspaceHarnessService instance"
    );
  }

  private getLastGatesPath(workspaceId: string): string {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");
    return path.join(this.config.sessionsDir, trimmed, LAST_GATES_FILENAME);
  }

  async getLastGateRun(workspaceId: string): Promise<HarnessGateRunResult | null> {
    const filePath = this.getLastGatesPath(workspaceId);

    try {
      const raw = await fsPromises.readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw) as unknown;
      const result = HarnessGateRunResultSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private async persistLastGateRun(
    workspaceId: string,
    result: HarnessGateRunResult
  ): Promise<void> {
    const filePath = this.getLastGatesPath(workspaceId);
    const dir = path.dirname(filePath);

    try {
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(filePath, JSON.stringify(result, null, 2) + "\n", "utf-8");
    } catch (error) {
      log.debug("[HARNESS] Failed to persist last gate run", { workspaceId, error });
    }
  }

  async runGates(
    workspaceId: string,
    gatesOverride?: HarnessGate[]
  ): Promise<Result<HarnessGateRunResult>> {
    assert(typeof workspaceId === "string", "workspaceId must be a string");

    const gates =
      gatesOverride ??
      (await this.workspaceHarnessService.getHarnessForWorkspace(workspaceId)).config.gates;

    const startedAt = Date.now();
    const results: HarnessGateRunResult["results"] = [];

    if (gates.length === 0) {
      const finishedAt = Date.now();
      const run: HarnessGateRunResult = {
        ok: true,
        startedAt,
        finishedAt,
        totalDurationMs: finishedAt - startedAt,
        results: [],
      };
      await this.persistLastGateRun(workspaceId, run);
      return Ok(run);
    }

    const { runtime, workspacePath } =
      await this.workspaceHarnessService.getRuntimeAndWorkspacePath(workspaceId);

    const readyResult = await runtime.ensureReady();
    if (!readyResult.ready) {
      const msg = readyResult.error ?? "Runtime not ready";
      return Err(msg);
    }

    let ok = true;

    for (const gate of gates) {
      const timeout = gate.timeoutSecs ?? 10 * 60;

      try {
        const execResult = await execBuffered(runtime, gate.command, {
          cwd: workspacePath,
          timeout,
        });

        const stdout = truncateOutput(execResult.stdout);
        const stderr = truncateOutput(execResult.stderr);

        results.push({
          command: gate.command,
          exitCode: execResult.exitCode,
          durationMs: execResult.duration,
          stdout: stdout.output,
          stderr: stderr.output,
          truncatedStdout: stdout.truncated || undefined,
          truncatedStderr: stderr.truncated || undefined,
        });

        if (execResult.exitCode !== 0) {
          ok = false;
        }
      } catch (error) {
        ok = false;
        const message = error instanceof Error ? error.message : String(error);

        results.push({
          command: gate.command,
          exitCode: 1,
          durationMs: 0,
          stdout: "",
          stderr: message,
        });
      }

      if (!ok) {
        // Stop at the first failure to keep iterations tight (Ralph-style backpressure).
        break;
      }
    }

    const finishedAt = Date.now();

    const run: HarnessGateRunResult = {
      ok,
      startedAt,
      finishedAt,
      totalDurationMs: finishedAt - startedAt,
      results,
    };

    await this.persistLastGateRun(workspaceId, run);
    await this.workspaceHarnessService.updateProgressFile(workspaceId);

    return Ok(run);
  }
}
