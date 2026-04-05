import { afterEach, describe, expect, test } from "bun:test";
import type { spawn as spawnProcess } from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { OpenSSHMasterPool, getShardedControlPath } from "./openSshMasterPool";
import type { SSHConnectionConfig } from "./sshConnectionPool";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  pid = 1234;
  exitCode: number | null = null;
  signalCode: string | null = null;

  kill(_signal?: string): boolean {
    this.exitCode ??= 0;
    this.emit("exit", this.exitCode, this.signalCode);
    this.emit("close", this.exitCode, this.signalCode);
    return true;
  }
}

describe("getShardedControlPath", () => {
  test("is deterministic per shard and unique across shards", () => {
    const config: SSHConnectionConfig = { host: "example.com" };
    expect(getShardedControlPath(config, 0)).toBe(getShardedControlPath(config, 0));
    expect(getShardedControlPath(config, 0)).not.toBe(getShardedControlPath(config, 1));
  });
});

describe("OpenSSHMasterPool", () => {
  const masterProcesses = new Map<string, FakeChildProcess>();

  afterEach(() => {
    masterProcesses.clear();
  });

  test("reuses an existing shard until capacity is reached, then scales out", async () => {
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 2,
      maxShardsPerHost: 4,
      sleep: () => Promise.resolve(),
      spawnProcess: ((command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];
        spawnCalls.push({ command, args: normalizedArgs });

        if (normalizedArgs.includes("-M")) {
          const controlPathArg = normalizedArgs.find((arg) => arg.startsWith("ControlPath="));
          if (controlPathArg) {
            masterProcesses.set(controlPathArg.slice("ControlPath=".length), proc);
          }
          return proc as never;
        }

        const controlPathIndex = normalizedArgs.indexOf("-S");
        const controlPath =
          controlPathIndex >= 0 ? normalizedArgs[controlPathIndex + 1] : undefined;
        queueMicrotask(() => {
          if (normalizedArgs.includes("check") && controlPath && masterProcesses.has(controlPath)) {
            proc.exitCode = 0;
          }
          proc.emit("close", proc.exitCode ?? 1, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    const first = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });
    const second = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });
    const third = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });

    expect(first.controlPath).toBe(second.controlPath);
    expect(third.controlPath).not.toBe(first.controlPath);
    expect(spawnCalls.filter((call) => call.args.includes("-M"))).toHaveLength(2);

    first.release();
    second.release();
    third.release();
    pool.clearAll();
  });

  test("does not lease a shard until its master is ready", async () => {
    let ready = false;
    let releaseStartupWait: (() => void) | undefined;
    const startupWait = new Promise<void>((resolve) => {
      releaseStartupWait = resolve;
    });

    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 2,
      maxShardsPerHost: 1,
      sleep: () => startupWait,
      spawnProcess: ((_command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];

        if (normalizedArgs.includes("-M")) {
          const controlPathArg = normalizedArgs.find((arg) => arg.startsWith("ControlPath="));
          if (controlPathArg) {
            masterProcesses.set(controlPathArg.slice("ControlPath=".length), proc);
          }
          return proc as never;
        }

        const controlPathIndex = normalizedArgs.indexOf("-S");
        const controlPath =
          controlPathIndex >= 0 ? normalizedArgs[controlPathIndex + 1] : undefined;
        queueMicrotask(() => {
          if (normalizedArgs.includes("check") && controlPath && masterProcesses.has(controlPath)) {
            proc.exitCode = ready ? 0 : 1;
          }
          proc.emit("close", proc.exitCode ?? 1, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    const firstPromise = pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });
    let secondResolved = false;
    const secondPromise = pool
      .acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 })
      .then((lease) => {
        secondResolved = true;
        return lease;
      });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);

    ready = true;
    releaseStartupWait?.();

    const first = await firstPromise;
    const second = await secondPromise;
    expect(first.controlPath).toBe(second.controlPath);

    first.release();
    second.release();
    pool.clearAll();
  });

  test("waits for shard backoff before reusing a failed master", async () => {
    let releaseBackoffWait: (() => void) | undefined;
    const backoffWait = new Promise<void>((resolve) => {
      releaseBackoffWait = resolve;
    });

    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 1,
      maxShardsPerHost: 1,
      sleep: () => backoffWait,
      spawnProcess: ((_command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];

        if (normalizedArgs.includes("-M")) {
          const controlPathArg = normalizedArgs.find((arg) => arg.startsWith("ControlPath="));
          if (controlPathArg) {
            masterProcesses.set(controlPathArg.slice("ControlPath=".length), proc);
          }
          return proc as never;
        }

        const controlPathIndex = normalizedArgs.indexOf("-S");
        const controlPath =
          controlPathIndex >= 0 ? normalizedArgs[controlPathIndex + 1] : undefined;
        queueMicrotask(() => {
          if (normalizedArgs.includes("check") && controlPath && masterProcesses.has(controlPath)) {
            proc.exitCode = 0;
          }
          proc.emit("close", proc.exitCode ?? 1, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    const first = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });
    first.reportFailure("ssh exited 255");
    first.release();

    let secondResolved = false;
    const secondPromise = pool
      .acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 })
      .then((lease) => {
        secondResolved = true;
        return lease;
      });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);

    const internals = pool as unknown as {
      hostGroups: Map<string, { shards: Array<{ health: { backoffUntil?: Date } }> }>;
    };
    const shard = [...internals.hostGroups.values()][0]?.shards[0];
    if (!shard) {
      throw new Error("Expected a tracked shard");
    }
    shard.health.backoffUntil = new Date(Date.now() - 1);
    releaseBackoffWait?.();

    const second = await secondPromise;
    expect(second.controlPath).toBe(first.controlPath);

    second.release();
    pool.clearAll();
  });

  test("honors shard backoff waits instead of polling at the startup cadence", async () => {
    const sleepCalls: number[] = [];
    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 1,
      maxShardsPerHost: 1,
      startupPollIntervalMs: 50,
      sleep: (waitMs) => {
        sleepCalls.push(waitMs);
        const internals = pool as unknown as {
          hostGroups: Map<string, { shards: Array<{ health: { backoffUntil?: Date } }> }>;
        };
        const shard = [...internals.hostGroups.values()][0]?.shards[0];
        if (shard?.health.backoffUntil) {
          shard.health.backoffUntil = new Date(Date.now() - 1);
        }
        return Promise.resolve();
      },
      spawnProcess: ((_command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];

        if (normalizedArgs.includes("-M")) {
          const controlPathArg = normalizedArgs.find((arg) => arg.startsWith("ControlPath="));
          if (controlPathArg) {
            masterProcesses.set(controlPathArg.slice("ControlPath=".length), proc);
          }
          return proc as never;
        }

        const controlPathIndex = normalizedArgs.indexOf("-S");
        const controlPath =
          controlPathIndex >= 0 ? normalizedArgs[controlPathIndex + 1] : undefined;
        queueMicrotask(() => {
          if (normalizedArgs.includes("check") && controlPath && masterProcesses.has(controlPath)) {
            proc.exitCode = 0;
          }
          proc.emit("close", proc.exitCode ?? 1, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    const first = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });
    sleepCalls.length = 0;
    first.reportFailure("ssh exited 255");
    first.release();

    const second = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });

    expect(sleepCalls[0]).toBeGreaterThan(100);

    second.release();
    pool.clearAll();
  });

  test("polls for free capacity when a healthy shard is saturated even if another shard is backing off", async () => {
    const sleepCalls: number[] = [];
    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 1,
      maxShardsPerHost: 2,
      startupPollIntervalMs: 50,
      sleep: (waitMs) => {
        sleepCalls.push(waitMs);
        return Promise.resolve();
      },
      spawnProcess: ((_command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];

        if (normalizedArgs.includes("-M")) {
          const controlPathArg = normalizedArgs.find((arg) => arg.startsWith("ControlPath="));
          if (controlPathArg) {
            masterProcesses.set(controlPathArg.slice("ControlPath=".length), proc);
          }
          return proc as never;
        }

        const controlPathIndex = normalizedArgs.indexOf("-S");
        const controlPath =
          controlPathIndex >= 0 ? normalizedArgs[controlPathIndex + 1] : undefined;
        queueMicrotask(() => {
          if (normalizedArgs.includes("check") && controlPath && masterProcesses.has(controlPath)) {
            proc.exitCode = 0;
          }
          proc.emit("close", proc.exitCode ?? 1, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    const first = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });
    const internals = pool as unknown as {
      hostGroups: Map<
        string,
        {
          shards: Array<{
            health: {
              backoffUntil?: Date;
              status: string;
              consecutiveFailures?: number;
              lastFailure?: Date;
              lastError?: string;
            };
            ready: boolean;
            inflight: number;
            process?: FakeChildProcess;
            startup?: Promise<void>;
            stopping: boolean;
            stderr: string;
            id: number;
            shardId: string;
            controlPath: string;
            lastUsedAt: number;
          }>;
        }
      >;
    };
    const group = [...internals.hostGroups.values()][0];
    if (!group) {
      throw new Error("Expected a tracked host group");
    }
    group.shards.push({
      id: 99,
      shardId: "shard-99",
      controlPath: "/tmp/mux-backoff-shard",
      inflight: 0,
      lastUsedAt: Date.now(),
      ready: false,
      stderr: "",
      stopping: false,
      health: {
        status: "unhealthy",
        consecutiveFailures: 1,
        lastFailure: new Date(),
        lastError: "ssh exited 255",
        backoffUntil: new Date(Date.now() + 10_000),
      },
    });

    const secondPromise = pool.acquireLease(config, {
      maxWaitMs: 1000,
      timeoutMs: 1000,
      onWait: () => {
        first.release();
      },
    });
    const second = await secondPromise;

    expect(sleepCalls[0]).toBe(50);

    second.release();
    pool.clearAll();
  });

  test("preserves shard failure history across retries after backoff expires", async () => {
    let startupAttempts = 0;
    const controller = new AbortController();
    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 1,
      maxShardsPerHost: 1,
      sleep: () => {
        const internals = pool as unknown as {
          hostGroups: Map<string, { shards: Array<{ health: { backoffUntil?: Date } }> }>;
        };
        const shard = [...internals.hostGroups.values()][0]?.shards[0];
        if (shard?.health.backoffUntil) {
          shard.health.backoffUntil = new Date(Date.now() - 1);
        }
        return Promise.resolve();
      },
      spawnProcess: ((_command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];

        if (normalizedArgs.includes("-M")) {
          startupAttempts += 1;
          queueMicrotask(() => {
            proc.emit("error", new Error(`startup failure ${startupAttempts}`));
            proc.exitCode = 1;
            proc.emit("exit", proc.exitCode, null);
            proc.emit("close", proc.exitCode, null);
            if (startupAttempts === 2) {
              controller.abort();
            }
          });
          return proc as never;
        }

        queueMicrotask(() => {
          proc.exitCode = 1;
          proc.emit("close", proc.exitCode, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    try {
      await pool.acquireLease(config, {
        maxWaitMs: 1000,
        timeoutMs: 1000,
        abortSignal: controller.signal,
      });
      throw new Error("Expected acquireLease to reject");
    } catch {
      // Expected: we abort after the second failed startup attempt.
    }

    const internals = pool as unknown as {
      hostGroups: Map<string, { shards: Array<{ health: { consecutiveFailures?: number } }> }>;
    };
    const shard = [...internals.hostGroups.values()][0]?.shards[0];
    if (!shard) {
      throw new Error("Expected a tracked shard");
    }
    expect(startupAttempts).toBe(2);
    expect(shard.health.consecutiveFailures).toBe(2);

    pool.clearAll();
  });

  test("ensureReadyMaster ignores saturated exec slots when a shard is already ready", async () => {
    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 1,
      maxShardsPerHost: 1,
      sleep: () => Promise.resolve(),
      spawnProcess: ((_command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];

        if (normalizedArgs.includes("-M")) {
          const controlPathArg = normalizedArgs.find((arg) => arg.startsWith("ControlPath="));
          if (controlPathArg) {
            masterProcesses.set(controlPathArg.slice("ControlPath=".length), proc);
          }
          return proc as never;
        }

        const controlPathIndex = normalizedArgs.indexOf("-S");
        const controlPath =
          controlPathIndex >= 0 ? normalizedArgs[controlPathIndex + 1] : undefined;
        queueMicrotask(() => {
          if (normalizedArgs.includes("check") && controlPath && masterProcesses.has(controlPath)) {
            proc.exitCode = 0;
          }
          proc.emit("close", proc.exitCode ?? 1, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    const lease = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });

    await pool.ensureReadyMaster(config, { maxWaitMs: 0, timeoutMs: 1000 });

    lease.release();
    pool.clearAll();
  });

  test("retries transient shard startup failures within the maxWait budget", async () => {
    let startupAttempts = 0;
    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 1,
      maxShardsPerHost: 1,
      sleep: () => {
        const internals = pool as unknown as {
          hostGroups: Map<string, { shards: Array<{ health: { backoffUntil?: Date } }> }>;
        };
        const shard = [...internals.hostGroups.values()][0]?.shards[0];
        if (shard?.health.backoffUntil) {
          shard.health.backoffUntil = new Date(Date.now() - 1);
        }
        return Promise.resolve();
      },
      spawnProcess: ((_command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];

        if (normalizedArgs.includes("-M")) {
          startupAttempts += 1;
          const controlPathArg = normalizedArgs.find((arg) => arg.startsWith("ControlPath="));
          if (controlPathArg && startupAttempts > 1) {
            masterProcesses.set(controlPathArg.slice("ControlPath=".length), proc);
          }
          if (startupAttempts === 1) {
            queueMicrotask(() => {
              proc.emit("error", new Error("transient startup failure"));
              proc.exitCode = 1;
              proc.emit("exit", proc.exitCode, null);
              proc.emit("close", proc.exitCode, null);
            });
          }
          return proc as never;
        }

        const controlPathIndex = normalizedArgs.indexOf("-S");
        const controlPath =
          controlPathIndex >= 0 ? normalizedArgs[controlPathIndex + 1] : undefined;
        queueMicrotask(() => {
          if (normalizedArgs.includes("check") && controlPath && masterProcesses.has(controlPath)) {
            proc.exitCode = 0;
          }
          proc.emit("close", proc.exitCode ?? 1, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    const lease = await pool.acquireLease(config, { maxWaitMs: 1000, timeoutMs: 1000 });

    expect(startupAttempts).toBe(2);

    lease.release();
    pool.clearAll();
  });

  test("records a failed master startup only once when ssh emits error and exit", async () => {
    const pool = new OpenSSHMasterPool({
      maxSessionsPerShard: 1,
      maxShardsPerHost: 1,
      sleep: () => Promise.resolve(),
      spawnProcess: ((_command: string, args?: readonly string[]) => {
        const proc = new FakeChildProcess();
        const normalizedArgs = [...(args ?? [])];

        if (normalizedArgs.includes("-M")) {
          queueMicrotask(() => {
            proc.emit("error", new Error("spawn ENOENT"));
            proc.exitCode = 1;
            proc.emit("exit", proc.exitCode, null);
            proc.emit("close", proc.exitCode, null);
          });
          return proc as never;
        }

        queueMicrotask(() => {
          proc.exitCode = 1;
          proc.emit("close", proc.exitCode, null);
        });
        return proc as never;
      }) as unknown as typeof spawnProcess,
    });

    const config: SSHConnectionConfig = { host: "remote.example.com", port: 22 };
    try {
      // Keep the wait budget below the minimum 0.8s backoff jitter so this assertion only
      // verifies one startup attempt, not whether acquireLease later retries within budget.
      await pool.acquireLease(config, { maxWaitMs: 100, timeoutMs: 1000 });
      throw new Error("Expected acquireLease to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("spawn ENOENT");
    }

    const internals = pool as unknown as {
      hostGroups: Map<string, { shards: Array<{ health: { consecutiveFailures?: number } }> }>;
    };
    const shard = [...internals.hostGroups.values()][0]?.shards[0];
    if (!shard) {
      throw new Error("Expected a tracked shard");
    }
    expect(shard.health.consecutiveFailures).toBe(1);

    pool.clearAll();
  });
});
