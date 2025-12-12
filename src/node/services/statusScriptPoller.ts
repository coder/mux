import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { STATUS_MESSAGE_MAX_LENGTH } from "@/common/constants/toolLimits";
import { log } from "@/node/services/log";
import {
  parseAgentStatusFromLine,
  type ParsedAgentStatus,
} from "@/common/utils/status/parseAgentStatus";

export interface StatusScriptPollerConfig {
  workspaceId: string;
  runtime: Runtime;
  cwd: string;
  env?: Record<string, string>;
  script: string;
  pollIntervalMs: number;
}

export class StatusScriptPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private generation = 0;
  private lastUrl: string | undefined;
  private lastEmitted: ParsedAgentStatus | undefined;
  private lastScript: string | undefined;

  constructor(private readonly onStatus: (status: ParsedAgentStatus) => void | Promise<void>) {}

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Set/replace the poller configuration.
   * Always runs the script immediately once.
   */
  set(config: StatusScriptPollerConfig): void {
    this.generation++;
    const gen = this.generation;

    // If the caller changes the script, don't leak the previous script's URL.
    if (this.lastScript !== config.script) {
      this.lastScript = config.script;
      this.lastUrl = undefined;
      this.lastEmitted = undefined;
    }

    this.stop();

    const run = () => {
      // Intentionally fire-and-forget; runOnce is internally serialized via this.running.
      this.runOnce(config, gen).catch(() => {
        // Ignore status script errors; keep last known status.
      });
    };

    // Run immediately (even if pollIntervalMs === 0)
    run();

    if (config.pollIntervalMs > 0) {
      this.timer = setInterval(run, config.pollIntervalMs);
    }
  }

  private statusesEqual(a: ParsedAgentStatus | undefined, b: ParsedAgentStatus): boolean {
    return a?.emoji === b.emoji && a?.message === b.message && a?.url === b.url;
  }

  private async runOnce(config: StatusScriptPollerConfig, gen: number): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const result = await execBuffered(config.runtime, config.script, {
        cwd: config.cwd,
        env: config.env,
        timeout: 5,
      });

      // If config changed while we were executing, drop the update.
      if (gen !== this.generation) {
        return;
      }

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      // Prefer stdout; fall back to stderr (useful for quick debugging scripts).
      const text = stdout.trim().length > 0 ? stdout : stderr;
      const firstNonEmptyLine = text
        .split(/\r?\n/g)
        .map((l) => l.trim())
        .find((l) => l.length > 0);

      if (!firstNonEmptyLine) {
        return;
      }

      const parsed = parseAgentStatusFromLine(firstNonEmptyLine, STATUS_MESSAGE_MAX_LENGTH);

      // Preserve last URL if subsequent updates omit it.
      const url = parsed.url ?? this.lastUrl;
      if (url) {
        this.lastUrl = url;
      }

      const nextStatus: ParsedAgentStatus = {
        ...parsed,
        ...(url ? { url } : {}),
      };

      // Avoid re-emitting the same status every poll interval.
      if (this.statusesEqual(this.lastEmitted, nextStatus)) {
        return;
      }
      this.lastEmitted = nextStatus;

      await this.onStatus(nextStatus);
    } catch (error) {
      // Ignore status script errors; keep last known status.
      // Only log in debug mode to avoid noisy console output for user scripts.
      log.debug("status_set: status script failed", {
        workspaceId: config.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
