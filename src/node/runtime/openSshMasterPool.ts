import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { HOST_KEY_APPROVAL_TIMEOUT_MS } from "@/common/constants/ssh";
import { formatSshEndpoint } from "@/common/utils/ssh/formatSshEndpoint";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
import {
  appendOpenSSHHostKeyPolicyArgs,
  getSshPromptService,
  isInteractiveHostKeyApprovalAvailable,
  type ConnectionHealth,
  type SSHConnectionConfig,
} from "./sshConnectionPool";
import { createMediatedAskpassSession } from "./openSshPromptMediation";

const DEFAULT_MASTER_START_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_SESSIONS_PER_SHARD = 4;
const DEFAULT_MAX_SHARDS_PER_HOST = 8;
const SHARD_IDLE_TTL_MS = 60_000;
const STARTUP_POLL_INTERVAL_MS = 50;
const BACKOFF_SCHEDULE = [1, 2, 4, 7, 10];

type SleepFn = (ms: number, abortSignal?: AbortSignal) => Promise<void>;

type SpawnFn = typeof spawn;

interface AcquireLeaseOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
  abortSignal?: AbortSignal;
  onWait?: (waitMs: number) => void;
}

export interface OpenSSHMasterLease {
  controlPath: string;
  shardId: string;
  release(): void;
  reportFailure(error: string): void;
  markHealthy(): void;
}

interface MasterShard {
  id: number;
  shardId: string;
  controlPath: string;
  process?: ChildProcess;
  startup?: Promise<void>;
  ready: boolean;
  stderr: string;
  stopping: boolean;
  inflight: number;
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  health: ConnectionHealth;
}

interface HostGroup {
  config: SSHConnectionConfig;
  shards: MasterShard[];
  nextShardId: number;
}

interface MasterPoolOptions {
  spawnProcess?: SpawnFn;
  sleep?: SleepFn;
  maxSessionsPerShard?: number;
  maxShardsPerHost?: number;
  startupPollIntervalMs?: number;
  defaultMasterStartTimeoutMs?: number;
  defaultMaxWaitMs?: number;
  shardIdleTtlMs?: number;
}

function withJitter(seconds: number): number {
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return seconds * jitterFactor;
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (abortSignal?.aborted) {
    throw new Error("Operation aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Operation aborted"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function makeConnectionKey(config: SSHConnectionConfig): string {
  return [
    os.userInfo().username,
    config.host,
    config.port?.toString() ?? "22",
    config.identityFile ?? "default",
  ].join(":");
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function getShardedControlPath(config: SSHConnectionConfig, shardId = 0): string {
  const key = makeConnectionKey(config);
  return path.join(os.tmpdir(), `mux-ssh-${hashKey(`${key}:${shardId}`)}`);
}

function createInitialHealth(): ConnectionHealth {
  return {
    status: "unknown",
    consecutiveFailures: 0,
  };
}

function isProcessAlive(proc: ChildProcess | undefined): boolean {
  return proc != null && proc.exitCode == null && proc.signalCode == null;
}

export class OpenSSHMasterPool {
  private readonly hostGroups = new Map<string, HostGroup>();
  private readonly spawnProcess: SpawnFn;
  private readonly sleep: SleepFn;
  private readonly maxSessionsPerShard: number;
  private readonly maxShardsPerHost: number;
  private readonly startupPollIntervalMs: number;
  private readonly defaultMasterStartTimeoutMs: number;
  private readonly defaultMaxWaitMs: number;
  private readonly shardIdleTtlMs: number;

  constructor(options: MasterPoolOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.sleep = options.sleep ?? sleepWithAbort;
    this.maxSessionsPerShard = options.maxSessionsPerShard ?? DEFAULT_MAX_SESSIONS_PER_SHARD;
    this.maxShardsPerHost = options.maxShardsPerHost ?? DEFAULT_MAX_SHARDS_PER_HOST;
    this.startupPollIntervalMs = options.startupPollIntervalMs ?? STARTUP_POLL_INTERVAL_MS;
    this.defaultMasterStartTimeoutMs =
      options.defaultMasterStartTimeoutMs ?? DEFAULT_MASTER_START_TIMEOUT_MS;
    this.defaultMaxWaitMs = options.defaultMaxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.shardIdleTtlMs = options.shardIdleTtlMs ?? SHARD_IDLE_TTL_MS;
  }

  async ensureConnection(
    config: SSHConnectionConfig,
    options?: AcquireLeaseOptions
  ): Promise<void> {
    const lease = await this.acquireLease(config, options);
    lease.release();
  }

  async ensureReadyMaster(
    config: SSHConnectionConfig,
    options?: AcquireLeaseOptions
  ): Promise<void> {
    const maxWaitMs = options?.maxWaitMs ?? this.defaultMaxWaitMs;
    const defaultStartTimeoutMs = options?.timeoutMs ?? this.defaultMasterStartTimeoutMs;
    const deadlineMs = Date.now() + maxWaitMs;
    const key = makeConnectionKey(config);
    const hostGroup = this.getOrCreateHostGroup(key, config);
    let lastStartError: Error | undefined;

    while (true) {
      if (options?.abortSignal?.aborted) {
        throw new Error("Operation aborted");
      }

      this.trimExitedShards(hostGroup);
      if (this.pickReadyShard(hostGroup)) {
        return;
      }

      const restartable = hostGroup.shards.find((shard) => {
        return (
          !isProcessAlive(shard.process) &&
          shard.startup == null &&
          (shard.health.backoffUntil == null || shard.health.backoffUntil.getTime() <= Date.now())
        );
      });
      if (restartable) {
        try {
          const startupTimeoutMs =
            maxWaitMs === 0
              ? defaultStartTimeoutMs
              : Math.min(defaultStartTimeoutMs, Math.max(1, deadlineMs - Date.now()));
          await this.startShard(hostGroup, restartable, startupTimeoutMs, options?.abortSignal);
          return;
        } catch (error) {
          if (options?.abortSignal?.aborted) {
            throw error;
          }
          lastStartError = error instanceof Error ? error : new Error(getErrorMessage(error));
        }
      }

      if (hostGroup.shards.length < this.maxShardsPerHost) {
        const shard = this.createShard(hostGroup);
        try {
          const startupTimeoutMs =
            maxWaitMs === 0
              ? defaultStartTimeoutMs
              : Math.min(defaultStartTimeoutMs, Math.max(1, deadlineMs - Date.now()));
          await this.startShard(hostGroup, shard, startupTimeoutMs, options?.abortSignal);
          return;
        } catch (error) {
          if (options?.abortSignal?.aborted) {
            throw error;
          }
          lastStartError = error instanceof Error ? error : new Error(getErrorMessage(error));
        }
      }

      const nextBackoffMs = this.getNextBackoffWaitMs(hostGroup);
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        if (lastStartError) {
          throw lastStartError;
        }
        throw new Error(
          `SSH master pool for ${config.host} did not become available within ${maxWaitMs}ms`
        );
      }

      const waitMs = this.getPoolWaitMs(remainingMs, nextBackoffMs);
      options?.onWait?.(waitMs);
      await this.sleep(waitMs, options?.abortSignal);
    }
  }

  async acquireLease(
    config: SSHConnectionConfig,
    options?: AcquireLeaseOptions
  ): Promise<OpenSSHMasterLease> {
    const maxWaitMs = options?.maxWaitMs ?? this.defaultMaxWaitMs;
    const defaultStartTimeoutMs = options?.timeoutMs ?? this.defaultMasterStartTimeoutMs;
    const deadlineMs = Date.now() + maxWaitMs;
    const key = makeConnectionKey(config);
    const hostGroup = this.getOrCreateHostGroup(key, config);
    let lastStartError: Error | undefined;

    while (true) {
      if (options?.abortSignal?.aborted) {
        throw new Error("Operation aborted");
      }

      this.trimExitedShards(hostGroup);
      const available = this.pickAvailableShard(hostGroup);
      if (available) {
        return this.reserveShard(available);
      }

      const restartable = hostGroup.shards.find((shard) => {
        return (
          !isProcessAlive(shard.process) &&
          shard.startup == null &&
          (shard.health.backoffUntil == null || shard.health.backoffUntil.getTime() <= Date.now())
        );
      });
      if (restartable) {
        try {
          const startupTimeoutMs =
            maxWaitMs === 0
              ? defaultStartTimeoutMs
              : Math.min(defaultStartTimeoutMs, Math.max(1, deadlineMs - Date.now()));
          await this.startShard(hostGroup, restartable, startupTimeoutMs, options?.abortSignal);
          return this.reserveShard(restartable);
        } catch (error) {
          if (options?.abortSignal?.aborted) {
            throw error;
          }
          lastStartError = error instanceof Error ? error : new Error(getErrorMessage(error));
        }
      }

      if (hostGroup.shards.length < this.maxShardsPerHost) {
        const shard = this.createShard(hostGroup);
        try {
          const startupTimeoutMs =
            maxWaitMs === 0
              ? defaultStartTimeoutMs
              : Math.min(defaultStartTimeoutMs, Math.max(1, deadlineMs - Date.now()));
          await this.startShard(hostGroup, shard, startupTimeoutMs, options?.abortSignal);
          return this.reserveShard(shard);
        } catch (error) {
          if (options?.abortSignal?.aborted) {
            throw error;
          }
          lastStartError = error instanceof Error ? error : new Error(getErrorMessage(error));
        }
      }

      const nextBackoffMs = this.getNextBackoffWaitMs(hostGroup);
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        if (lastStartError) {
          throw lastStartError;
        }
        throw new Error(
          `SSH master pool for ${config.host} did not become available within ${maxWaitMs}ms`
        );
      }

      const waitMs = this.getPoolWaitMs(
        remainingMs,
        nextBackoffMs,
        this.pickReadyShard(hostGroup) != null
      );
      options?.onWait?.(waitMs);
      await this.sleep(waitMs, options?.abortSignal);
    }
  }

  clearAll(): void {
    for (const group of this.hostGroups.values()) {
      for (const shard of group.shards) {
        this.disposeShard(group, shard, { expected: true });
      }
    }
    this.hostGroups.clear();
  }

  private getOrCreateHostGroup(key: string, config: SSHConnectionConfig): HostGroup {
    const existing = this.hostGroups.get(key);
    if (existing) {
      return existing;
    }

    const group: HostGroup = {
      config,
      shards: [],
      nextShardId: 0,
    };
    this.hostGroups.set(key, group);
    return group;
  }

  private createShard(group: HostGroup): MasterShard {
    const id = group.nextShardId++;
    const shard: MasterShard = {
      id,
      shardId: `shard-${id}`,
      controlPath: getShardedControlPath(group.config, id),
      inflight: 0,
      lastUsedAt: Date.now(),
      ready: false,
      stderr: "",
      stopping: false,
      health: createInitialHealth(),
    };
    group.shards.push(shard);
    return shard;
  }

  private getPoolWaitMs(
    remainingMs: number,
    nextBackoffMs: number | undefined,
    preferPolling = false
  ): number {
    return Math.min(
      remainingMs,
      preferPolling || nextBackoffMs == null ? this.startupPollIntervalMs : nextBackoffMs
    );
  }

  private getReadyShards(group: HostGroup): MasterShard[] {
    return group.shards.filter((shard) => {
      const backoffUntilMs = shard.health.backoffUntil?.getTime();
      return (
        shard.ready &&
        isProcessAlive(shard.process) &&
        (backoffUntilMs == null || backoffUntilMs <= Date.now())
      );
    });
  }

  private pickReadyShard(group: HostGroup): MasterShard | undefined {
    return this.getReadyShards(group).sort((left, right) => left.inflight - right.inflight)[0];
  }

  private pickAvailableShard(group: HostGroup): MasterShard | undefined {
    return this.getReadyShards(group)
      .filter((shard) => shard.inflight < this.maxSessionsPerShard)
      .sort((left, right) => left.inflight - right.inflight)[0];
  }

  private reserveShard(shard: MasterShard): OpenSSHMasterLease {
    clearTimeout(shard.idleTimer);
    shard.idleTimer = undefined;
    shard.inflight += 1;
    shard.lastUsedAt = Date.now();

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      shard.inflight = Math.max(0, shard.inflight - 1);
      shard.lastUsedAt = Date.now();
      if (shard.inflight === 0) {
        this.scheduleIdleDisposal(shard);
      }
    };

    return {
      controlPath: shard.controlPath,
      shardId: shard.shardId,
      release,
      markHealthy: () => {
        shard.health = {
          status: "healthy",
          consecutiveFailures: 0,
          lastSuccess: new Date(),
        };
      },
      reportFailure: (error: string) => {
        this.recordShardFailure(shard, error);
      },
    };
  }

  private scheduleIdleDisposal(shard: MasterShard): void {
    clearTimeout(shard.idleTimer);
    shard.idleTimer = setTimeout(() => {
      const hostGroup = this.findHostGroupForShard(shard);
      if (!hostGroup) {
        return;
      }
      if (shard.inflight !== 0) {
        return;
      }
      this.disposeShard(hostGroup, shard, { expected: true });
    }, this.shardIdleTtlMs);
    shard.idleTimer.unref?.();
  }

  private findHostGroupForShard(target: MasterShard): HostGroup | undefined {
    for (const group of this.hostGroups.values()) {
      if (group.shards.includes(target)) {
        return group;
      }
    }
    return undefined;
  }

  private async startShard(
    group: HostGroup,
    shard: MasterShard,
    timeoutMs: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (shard.startup) {
      return shard.startup;
    }

    shard.startup = this.startShardInner(group, shard, timeoutMs, abortSignal).finally(() => {
      shard.startup = undefined;
    });
    return shard.startup;
  }

  private async startShardInner(
    group: HostGroup,
    shard: MasterShard,
    timeoutMs: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const canPromptInteractively = isInteractiveHostKeyApprovalAvailable();
    const promptService = getSshPromptService();
    let stderr = "";
    let scheduleKill = (_ms: number) => undefined;
    const extendDeadline = (ms: number) => scheduleKill(ms);

    const askpass =
      canPromptInteractively && promptService
        ? await createMediatedAskpassSession({
            sshPromptService: promptService,
            promptPolicy: {
              allowHostKey: true,
              allowCredential: false,
            },
            dedupeKey: `${formatSshEndpoint(group.config.host, group.config.port ?? 22)}:${shard.shardId}`,
            getStderrContext: () => stderr,
            onHostKeyPromptStarted: () => {
              extendDeadline(HOST_KEY_APPROVAL_TIMEOUT_MS);
            },
          })
        : undefined;

    const connectTimeout = canPromptInteractively
      ? Math.ceil(HOST_KEY_APPROVAL_TIMEOUT_MS / 1000)
      : Math.min(Math.ceil(timeoutMs / 1000), 15);
    const args = this.buildMasterArgs(group.config, shard.controlPath, connectTimeout);
    const proc = this.spawnProcess("ssh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(askpass ? { env: { ...process.env, ...askpass.env } } : {}),
    });

    shard.process = proc;
    shard.ready = false;
    shard.stderr = "";
    shard.stopping = false;

    let shardFailureRecorded = false;
    const recordShardFailureOnce = (error: string) => {
      if (shardFailureRecorded) {
        return;
      }
      shardFailureRecorded = true;
      this.recordShardFailure(shard, error);
    };

    const markShardUnavailable = (error: string) => {
      clearTimeout(shard.idleTimer);
      shard.idleTimer = undefined;
      shard.process = undefined;
      shard.ready = false;
      if (shard.stopping) {
        shard.stopping = false;
        return;
      }
      recordShardFailureOnce(error);
    };

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      shard.stderr += chunk;
    });

    const onUnexpectedError = (error: Error) => {
      const message = getErrorMessage(error);
      stderr = stderr.length > 0 ? `${stderr}\n${message}` : message;
      shard.stderr = stderr;
      markShardUnavailable(message);
    };
    proc.once("error", onUnexpectedError);

    const onUnexpectedExit = (code: number | null, signal: string | null) => {
      markShardUnavailable(
        stderr.trim() || `SSH master exited unexpectedly (${code ?? signal ?? "unknown"})`
      );
    };
    proc.once("exit", onUnexpectedExit);

    let timer: ReturnType<typeof setTimeout> | undefined;
    scheduleKill = (ms: number) => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        this.disposeShard(group, shard, { expected: false });
      }, ms);
    };

    scheduleKill(timeoutMs);

    try {
      await this.waitForMasterReady(group.config, shard, abortSignal);
      shard.ready = true;
      shard.health = {
        status: "healthy",
        consecutiveFailures: 0,
        lastSuccess: new Date(),
      };
      log.debug(`Started OpenSSH master ${shard.shardId} for ${group.config.host}`);
    } catch (error) {
      shard.ready = false;
      recordShardFailureOnce(getErrorMessage(error));
      this.disposeShard(group, shard, { expected: true });
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      askpass?.cleanup();
    }
  }

  private async waitForMasterReady(
    config: SSHConnectionConfig,
    shard: MasterShard,
    abortSignal?: AbortSignal
  ): Promise<void> {
    while (true) {
      if (abortSignal?.aborted) {
        throw new Error("Operation aborted");
      }
      if (!isProcessAlive(shard.process)) {
        throw new Error(shard.stderr.trim() || "SSH master exited before becoming ready");
      }

      const ready = await this.checkMaster(config, shard.controlPath);
      if (ready) {
        return;
      }

      await this.sleep(this.startupPollIntervalMs, abortSignal);
    }
  }

  private async checkMaster(config: SSHConnectionConfig, controlPath: string): Promise<boolean> {
    const args: string[] = ["-S", controlPath, "-O", "check"];
    if (config.port) {
      args.push("-p", config.port.toString());
    }
    if (config.identityFile) {
      args.push("-i", config.identityFile);
    }
    args.push(config.host);

    return new Promise<boolean>((resolve) => {
      const proc = this.spawnProcess("ssh", args, {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      proc.once("close", (code) => resolve(code === 0));
      proc.once("error", () => resolve(false));
    });
  }

  private buildMasterArgs(
    config: SSHConnectionConfig,
    controlPath: string,
    connectTimeout: number
  ): string[] {
    const args: string[] = ["-M", "-N", "-T"];

    if (config.port) {
      args.push("-p", config.port.toString());
    }
    if (config.identityFile) {
      args.push("-i", config.identityFile);
    }

    args.push("-o", "LogLevel=FATAL");
    args.push("-o", "ControlMaster=yes");
    args.push("-o", `ControlPath=${controlPath}`);
    args.push("-o", "ControlPersist=no");
    args.push("-o", `ConnectTimeout=${connectTimeout}`);
    args.push("-o", "ServerAliveInterval=5");
    args.push("-o", "ServerAliveCountMax=2");
    appendOpenSSHHostKeyPolicyArgs(args);
    args.push(config.host);

    return args;
  }

  private recordShardFailure(shard: MasterShard, error: string): void {
    const failures = (shard.health.consecutiveFailures ?? 0) + 1;
    const backoffIndex = Math.min(failures - 1, BACKOFF_SCHEDULE.length - 1);
    const backoffSecs = withJitter(BACKOFF_SCHEDULE[backoffIndex]);
    shard.health = {
      status: "unhealthy",
      lastFailure: new Date(),
      lastError: error,
      consecutiveFailures: failures,
      backoffUntil: new Date(Date.now() + backoffSecs * 1000),
    };
    log.warn(
      `OpenSSH master ${shard.shardId} failed for ${shard.controlPath}: ${error} (backoff ${backoffSecs.toFixed(1)}s)`
    );
  }

  private getNextBackoffWaitMs(group: HostGroup): number | undefined {
    const waits = group.shards
      .map((shard) => shard.health.backoffUntil?.getTime())
      .filter((value): value is number => value != null)
      .map((until) => until - Date.now())
      .filter((value) => value > 0);
    if (waits.length === 0) {
      return undefined;
    }
    return Math.min(...waits);
  }

  private trimExitedShards(group: HostGroup): void {
    group.shards = group.shards.filter((shard) => {
      if (isProcessAlive(shard.process) || shard.startup) {
        return true;
      }
      if (shard.inflight > 0) {
        return true;
      }
      if (shard.health.status === "unhealthy") {
        return true;
      }
      const backoffUntil = shard.health.backoffUntil?.getTime();
      return backoffUntil != null && backoffUntil > Date.now();
    });
  }

  private disposeShard(group: HostGroup, shard: MasterShard, options: { expected: boolean }): void {
    clearTimeout(shard.idleTimer);
    shard.idleTimer = undefined;
    shard.ready = false;
    shard.stopping = options.expected;

    const masterProcess = shard.process;
    if (masterProcess && isProcessAlive(masterProcess)) {
      const args: string[] = ["-S", shard.controlPath, "-O", "exit"];
      if (group.config.port) {
        args.push("-p", group.config.port.toString());
      }
      if (group.config.identityFile) {
        args.push("-i", group.config.identityFile);
      }
      args.push(group.config.host);

      const exitProc = this.spawnProcess("ssh", args, {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      exitProc.once("error", () => {
        try {
          masterProcess.kill("SIGTERM");
        } catch {
          // Ignore process teardown failures.
        }
      });
      const hardKill = setTimeout(() => {
        try {
          masterProcess.kill("SIGKILL");
        } catch {
          // Ignore process teardown failures.
        }
      }, 1000);
      hardKill.unref?.();
      masterProcess.once("exit", () => clearTimeout(hardKill));
      exitProc.once("close", (code) => {
        if (code === 0) {
          clearTimeout(hardKill);
          return;
        }
        try {
          masterProcess.kill("SIGTERM");
        } catch {
          // Ignore process teardown failures.
        }
      });
    }

    shard.stderr = "";
  }
}

export const openSshMasterPool = new OpenSSHMasterPool();
