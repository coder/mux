/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import type { ChildProcess } from "child_process";
import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import { execAsync } from "./disposableExec";

/**
 * Tests for DisposableExec - verifies no process leaks under any scenario
 *
 * These tests access internal implementation details (child process) to verify cleanup.
 * The eslint disables are necessary for test verification purposes.
 */

describe("disposableExec", () => {
  const activeProcesses = new Set<ChildProcess>();

  beforeEach(() => {
    activeProcesses.clear();
  });

  afterEach(() => {
    // Verify all processes are cleaned up after each test
    for (const proc of activeProcesses) {
      const hasExited = proc.exitCode !== null || proc.signalCode !== null;
      expect(hasExited || proc.killed).toBe(true);
      if (!hasExited && !proc.killed) {
        proc.kill();
      }
    }
    activeProcesses.clear();
  });

  test("successful command completes and cleans up automatically", async () => {
    let childProc: ChildProcess;

    {
      using proc = execAsync("echo 'hello world'");
      childProc = (proc as any).child;
      activeProcesses.add(childProc);

      const { stdout } = await proc.result;
      expect(stdout.trim()).toBe("hello world");
    }

    // After scope exit, process should be exited
    expect(childProc.exitCode).toBe(0);
    expect(childProc.killed).toBe(false);
  });

  test("failed command completes and cleans up automatically", async () => {
    using proc = execAsync("exit 1");
    const childProc: ChildProcess = (proc as any).child;
    activeProcesses.add(childProc);

    try {
      await proc.result;
      expect(true).toBe(false); // Should not reach here
    } catch (error: any) {
      expect(error.code).toBe(1);
    }

    // After scope exit, process should be exited
    expect(childProc.exitCode).toBe(1);
    expect(childProc.killed).toBe(false);
  });

  test("disposing before completion kills the process", async () => {
    const proc = execAsync("sleep 2");
    const childProc: ChildProcess = (proc as any).child;
    activeProcesses.add(childProc);

    // Give process time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(childProc.exitCode).toBeNull();
    expect(childProc.signalCode).toBeNull();

    // Explicit disposal - kill the process
    proc[Symbol.dispose]();

    // Wait for process to be killed
    await new Promise((resolve) => {
      if (childProc.killed) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed
    expect(childProc.killed).toBe(true);

    // Result promise should reject since we killed it
    await expect(proc.result).rejects.toThrow();
  });

  test("using block disposes and kills long-running process", async () => {
    let childProc: ChildProcess;
    let resultPromise: Promise<{ stdout: string; stderr: string }>;

    {
      using proc = execAsync("sleep 2");
      childProc = (proc as any).child;
      resultPromise = proc.result;
      activeProcesses.add(childProc);

      // Give process time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(childProc.exitCode).toBeNull();
      expect(childProc.signalCode).toBeNull();
      // Exit scope - should trigger disposal
    }

    // Wait for process to be killed
    await new Promise((resolve) => {
      if (childProc.killed || childProc.exitCode !== null) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed
    expect(childProc.killed).toBe(true);

    // Result should reject since we killed it
    await expect(resultPromise).rejects.toThrow();
  });

  test("disposing already-exited process is safe", async () => {
    const proc = execAsync("echo 'test'");
    const childProc: ChildProcess = (proc as any).child;
    activeProcesses.add(childProc);

    await proc.result;

    // Process already exited
    expect(childProc.exitCode).toBe(0);

    // Should not throw or cause issues
    proc[Symbol.dispose]();

    // Still exited, not killed
    expect(childProc.exitCode).toBe(0);
    expect(childProc.killed).toBe(false);
  });

  test("stdout and stderr are captured correctly", async () => {
    using proc = execAsync("echo 'stdout message' && echo 'stderr message' >&2");
    const childProc = (proc as any).child;
    activeProcesses.add(childProc);

    const { stdout, stderr } = await proc.result;
    expect(stdout.trim()).toBe("stdout message");
    expect(stderr.trim()).toBe("stderr message");
  });

  test("error includes stderr content", async () => {
    try {
      using proc = execAsync("echo 'error details' >&2 && exit 42");
      const childProc = (proc as any).child;
      activeProcesses.add(childProc);

      await proc.result;
      expect(true).toBe(false); // Should not reach
    } catch (error: any) {
      expect(error.code).toBe(42);
      expect(error.stderr.trim()).toBe("error details");
      expect(error.message).toContain("error details");
    }
  });

  test("multiple processes in parallel all clean up", async () => {
    const childProcs: ChildProcess[] = [];

    await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        using proc = execAsync(`echo 'process ${i}'`);
        const childProc = (proc as any).child;
        childProcs.push(childProc);
        activeProcesses.add(childProc);

        const { stdout } = await proc.result;
        expect(stdout.trim()).toBe(`process ${i}`);
      })
    );

    // All processes should be exited
    for (const proc of childProcs) {
      expect(proc.exitCode).toBe(0);
    }
  });

  test("exception during process handling still cleans up", async () => {
    let childProc: ChildProcess | undefined;
    let resultPromise: Promise<{ stdout: string; stderr: string }> | undefined;

    try {
      using proc = execAsync("sleep 2");
      childProc = (proc as any).child as ChildProcess;
      resultPromise = proc.result;
      activeProcesses.add(childProc);

      // Give process time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Throw exception before awaiting result - disposal will happen when leaving this block
      throw new Error("Simulated error");
    } catch (error: any) {
      expect(error.message).toBe("Simulated error");
    }

    // Wait for process to be killed
    if (childProc) {
      await new Promise((resolve) => {
        if (childProc.killed || childProc.exitCode !== null) {
          resolve(undefined);
        } else {
          childProc.once("exit", () => resolve(undefined));
        }
      });
    }

    // Process should be killed despite exception
    expect(childProc?.killed).toBe(true);

    // After leaving try block, disposal has occurred
    // Result should reject since we killed it via disposal
    await expect(resultPromise).rejects.toThrow();
  });

  test("process killed by signal is handled correctly", async () => {
    using proc = execAsync("sleep 2");
    const childProc: ChildProcess = (proc as any).child;
    activeProcesses.add(childProc);

    try {
      // Give process time to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Manually kill with SIGTERM
      childProc.kill("SIGTERM");

      await proc.result;
      expect(true).toBe(false); // Should not reach
    } catch (error: any) {
      expect(error.signal).toBe("SIGTERM");
      expect(error.message).toContain("SIGTERM");
    }

    // Wait for process to fully exit
    await new Promise((resolve) => {
      if (childProc.exitCode !== null || childProc.signalCode !== null) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed
    expect(childProc.killed).toBe(true);
    expect(childProc.signalCode).toBe("SIGTERM");
  });

  test("early disposal prevents result promise from hanging", async () => {
    const proc = execAsync("sleep 2");
    const childProc = (proc as any).child;
    activeProcesses.add(childProc);

    // Give process time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Dispose immediately
    proc[Symbol.dispose]();

    // Wait for process to be killed
    await new Promise((resolve) => {
      if (childProc.killed || childProc.exitCode !== null) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed
    expect(childProc.killed).toBe(true);

    // Result should reject, not hang forever
    await expect(proc.result).rejects.toThrow();
  });

  test("dispose is idempotent - calling multiple times is safe", async () => {
    const proc = execAsync("sleep 2");
    const childProc = (proc as any).child;
    activeProcesses.add(childProc);

    // Give process time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Multiple dispose calls should be safe
    proc[Symbol.dispose]();
    proc[Symbol.dispose]();
    proc[Symbol.dispose]();

    // Wait for process to be killed
    await new Promise((resolve) => {
      if (childProc.killed || childProc.exitCode !== null) {
        resolve(undefined);
      } else {
        childProc.once("exit", () => resolve(undefined));
      }
    });

    // Process should be killed once
    expect(childProc.killed).toBe(true);

    // Result should reject since we killed it
    await expect(proc.result).rejects.toThrow();
  });

  test("close event waits for stdio to flush", async () => {
    // Generate large output to test stdio buffering
    const largeOutput = "x".repeat(100000);
    using proc = execAsync(`echo '${largeOutput}'`);
    const childProc = (proc as any).child;
    activeProcesses.add(childProc);

    const { stdout } = await proc.result;

    // Should receive all output, not truncated
    expect(stdout.trim()).toBe(largeOutput);
    expect(stdout.trim().length).toBe(largeOutput.length);
  });
});
