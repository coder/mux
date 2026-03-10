import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createServer } from "http";

import * as mcpSdk from "@ai-sdk/mcp";
import {
  MCPServerManager,
  isClosedClientError,
  runMCPToolWithDeadline,
  wrapMCPTools,
} from "./mcpServerManager";
import type { MCPConfigService } from "./mcpConfigService";
import type { Runtime } from "@/node/runtime/Runtime";
import type { Tool } from "ai";

interface MCPServerManagerTestAccess {
  workspaceServers: Map<string, unknown>;
  cleanupIdleServers: () => void;
  startServers: (...args: unknown[]) => Promise<{
    instances: Map<string, unknown>;
    failedServerNames: string[];
    timedOutServerNames?: string[];
  }>;
  startSingleServer: (...args: unknown[]) => Promise<unknown>;
  startSingleServerImpl: (...args: unknown[]) => Promise<unknown>;
}

describe("MCPServerManager", () => {
  let configService: {
    listServers: ReturnType<typeof mock>;
  };

  let manager: MCPServerManager;
  let access: MCPServerManagerTestAccess;

  beforeEach(() => {
    configService = {
      listServers: mock(() => Promise.resolve({})),
    };

    manager = new MCPServerManager(configService as unknown as MCPConfigService);
    access = manager as unknown as MCPServerManagerTestAccess;
  });

  afterEach(() => {
    manager.dispose();
  });

  test("cleanupIdleServers stops idle servers when workspace is not leased", () => {
    const workspaceId = "ws-idle";

    const close = mock(() => Promise.resolve(undefined));

    const instance = {
      name: "server",
      resolvedTransport: "stdio",
      autoFallbackUsed: false,
      tools: {},
      isClosed: false,
      close,
    };

    const entry = {
      configSignature: "sig",
      instances: new Map([["server", instance]]),
      stats: {
        enabledServerCount: 1,
        startedServerCount: 1,
        failedServerCount: 0,
        autoFallbackCount: 0,
        failedServerNames: [],
        hasStdio: true,
        hasHttp: false,
        hasSse: false,
        transportMode: "stdio_only",
      },
      lastActivity: Date.now() - 11 * 60_000,
    };

    access.workspaceServers.set(workspaceId, entry);

    access.cleanupIdleServers();

    expect(access.workspaceServers.has(workspaceId)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("cleanupIdleServers does not stop idle servers when workspace is leased", () => {
    const workspaceId = "ws-leased";

    const close = mock(() => Promise.resolve(undefined));

    const instance = {
      name: "server",
      resolvedTransport: "stdio",
      autoFallbackUsed: false,
      tools: {},
      isClosed: false,
      close,
    };

    const entry = {
      configSignature: "sig",
      instances: new Map([["server", instance]]),
      stats: {
        enabledServerCount: 1,
        startedServerCount: 1,
        failedServerCount: 0,
        autoFallbackCount: 0,
        failedServerNames: [],
        hasStdio: true,
        hasHttp: false,
        hasSse: false,
        transportMode: "stdio_only",
      },
      lastActivity: Date.now() - 11 * 60_000,
    };

    access.workspaceServers.set(workspaceId, entry);
    manager.acquireLease(workspaceId);

    // Ensure the workspace still looks idle even after acquireLease() updates activity.
    (entry as { lastActivity: number }).lastActivity = Date.now() - 11 * 60_000;

    access.cleanupIdleServers();

    expect(access.workspaceServers.has(workspaceId)).toBe(true);
    expect(close).toHaveBeenCalledTimes(0);
  });

  test("startSingleServer times out when startup never finishes", async () => {
    const never = Promise.withResolvers<unknown>();
    const startSingleServerImplMock = mock(() => never.promise);
    access.startSingleServerImpl = startSingleServerImplMock;

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      delay?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) => originalSetTimeout(callback, delay === 60_000 ? 1 : delay, ...args)) as typeof setTimeout);

    try {
      let caught: unknown;
      try {
        await access.startSingleServer(
          "stuck-server",
          { transport: "stdio", command: "never" },
          {} as Runtime,
          "/tmp/project",
          "/tmp/workspace",
          undefined,
          () => undefined
        );
      } catch (error) {
        caught = error;
      }

      expect(startSingleServerImplMock).toHaveBeenCalledTimes(1);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("stuck-server");
      expect((caught as Error).message).toContain("timed out");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("startSingleServer waits for abort cleanup before surfacing timeout", async () => {
    const cleanup = Promise.withResolvers<void>();
    const startSingleServerImplMock = mock((...args: unknown[]) => {
      const signal = args[7] as AbortSignal;
      const registerAbortCleanup = args[8] as ((cleanupPromise: Promise<void>) => void) | undefined;

      return new Promise<null>((resolve) => {
        const onAbort = () => {
          const cleanupPromise = cleanup.promise;
          registerAbortCleanup?.(cleanupPromise);
          cleanupPromise.then(
            () => resolve(null),
            () => resolve(null)
          );
        };

        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    access.startSingleServerImpl = startSingleServerImplMock;

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      delay?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) => originalSetTimeout(callback, delay === 60_000 ? 1 : delay, ...args)) as typeof setTimeout);

    try {
      let settled = false;
      let caught: unknown;

      const startPromise = access
        .startSingleServer(
          "cleanup-server",
          { transport: "stdio", command: "never" },
          {} as Runtime,
          "/tmp/project",
          "/tmp/workspace",
          undefined,
          () => undefined
        )
        .then(
          () => {
            settled = true;
          },
          (error) => {
            settled = true;
            caught = error;
          }
        );

      await new Promise<void>((resolve) => originalSetTimeout(resolve, 5));
      expect(settled).toBe(false);

      cleanup.resolve();
      await startPromise;

      expect(startSingleServerImplMock).toHaveBeenCalledTimes(1);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("cleanup-server");
      expect((caught as Error).message).toContain("timed out");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("startSingleServer still times out when abort cleanup hangs", async () => {
    const startSingleServerImplMock = mock((...args: unknown[]) => {
      const signal = args[7] as AbortSignal;
      const registerAbortCleanup = args[8] as ((cleanupPromise: Promise<void>) => void) | undefined;
      const cleanupNever = new Promise<void>(() => undefined);

      return new Promise<null>(() => {
        const onAbort = () => {
          registerAbortCleanup?.(cleanupNever);
        };

        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener("abort", onAbort, { once: true });
      });
    });
    access.startSingleServerImpl = startSingleServerImplMock;

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      _delay?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) => originalSetTimeout(callback, 1, ...args)) as typeof setTimeout);

    try {
      let caught: unknown;
      try {
        await access.startSingleServer(
          "cleanup-hang-server",
          { transport: "stdio", command: "never" },
          {} as Runtime,
          "/tmp/project",
          "/tmp/workspace",
          undefined,
          () => undefined
        );
      } catch (error) {
        caught = error;
      }

      expect(startSingleServerImplMock).toHaveBeenCalledTimes(1);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("cleanup-hang-server");
      expect((caught as Error).message).toContain("timed out");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("startServers only marks startup timeouts as retryable", async () => {
    const never = Promise.withResolvers<unknown>();
    access.startSingleServerImpl = mock((name: unknown) => {
      if (name === "slow-server") {
        return never.promise;
      }

      if (name === "broken-server") {
        return Promise.reject(new Error("invalid MCP server config"));
      }

      return Promise.resolve({
        name: String(name),
        resolvedTransport: "stdio",
        autoFallbackUsed: false,
        tools: {},
        isClosed: false,
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    setTimeoutSpy.mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      delay?: Parameters<typeof setTimeout>[1],
      ...args: unknown[]
    ) => originalSetTimeout(callback, delay === 60_000 ? 1 : delay, ...args)) as typeof setTimeout);

    try {
      const result = await access.startServers(
        {
          "slow-server": { transport: "stdio", command: "slow", disabled: false },
          "broken-server": { transport: "stdio", command: "broken", disabled: false },
        },
        {} as Runtime,
        "/tmp/project",
        "/tmp/workspace",
        undefined,
        () => undefined
      );

      expect(result.failedServerNames).toEqual(["slow-server", "broken-server"]);
      expect(result.timedOutServerNames).toEqual(["slow-server"]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("startSingleServerImpl closes spawned stdio stream when aborted after exec", async () => {
    const controller = new AbortController();
    const stdinClose = mock(() => Promise.resolve(undefined));
    const stdoutCancel = mock(() => Promise.resolve(undefined));
    const stderrCancel = mock(() => Promise.resolve(undefined));

    const exec = mock((_command: string) => {
      controller.abort();

      return Promise.resolve({
        stdin: new WritableStream<Uint8Array>({
          close: stdinClose,
        }),
        stdout: new ReadableStream<Uint8Array>({
          cancel: stdoutCancel,
        }),
        stderr: new ReadableStream<Uint8Array>({
          cancel: stderrCancel,
        }),
        exitCode: Promise.resolve(0),
        duration: Promise.resolve(0),
      });
    });

    const result = await access.startSingleServerImpl(
      "stdio-aborted-after-exec",
      { transport: "stdio", command: "never" },
      { exec } as unknown as Runtime,
      "/tmp/project",
      "/tmp/workspace",
      undefined,
      () => undefined,
      controller.signal
    );

    expect(result).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(stdinClose).toHaveBeenCalledTimes(1);
    expect(stdoutCancel).toHaveBeenCalledTimes(1);
    expect(stderrCancel).toHaveBeenCalledTimes(1);
  });

  test("startSingleServerImpl cleans up client that resolves after abort", async () => {
    const controller = new AbortController();
    const stdinClose = mock(() => Promise.resolve(undefined));
    const stdoutCancel = mock(() => Promise.resolve(undefined));
    const lateClientClose = mock(() => Promise.resolve(undefined));
    const createClient =
      Promise.withResolvers<Awaited<ReturnType<typeof mcpSdk.createMCPClient>>>();

    const createMCPClientSpy = spyOn(mcpSdk, "createMCPClient").mockImplementation(() => {
      controller.abort();
      return createClient.promise;
    });

    try {
      const exec = mock((_command: string) =>
        Promise.resolve({
          stdin: new WritableStream<Uint8Array>({
            close: stdinClose,
          }),
          stdout: new ReadableStream<Uint8Array>({
            cancel: stdoutCancel,
          }),
          stderr: new ReadableStream<Uint8Array>(),
          exitCode: Promise.resolve(0),
          duration: Promise.resolve(0),
        })
      );

      const startup = access.startSingleServerImpl(
        "stdio-late-client-cleanup",
        { transport: "stdio", command: "never" },
        { exec } as unknown as Runtime,
        "/tmp/project",
        "/tmp/workspace",
        undefined,
        () => undefined,
        controller.signal
      );

      createClient.resolve({
        close: lateClientClose,
        tools: mock(() => Promise.resolve({})),
      } as unknown as Awaited<ReturnType<typeof mcpSdk.createMCPClient>>);

      const result = await startup;

      expect(result).toBeNull();
      expect(exec).toHaveBeenCalledTimes(1);
      expect(stdinClose).toHaveBeenCalledTimes(1);
      expect(stdoutCancel).toHaveBeenCalledTimes(1);
      expect(lateClientClose).toHaveBeenCalledTimes(1);
    } finally {
      createMCPClientSpy.mockRestore();
    }
  });

  test("startSingleServerImpl cleans up HTTP client that resolves after abort", async () => {
    const controller = new AbortController();
    const lateClientClose = mock(() => Promise.resolve(undefined));
    const createClient =
      Promise.withResolvers<Awaited<ReturnType<typeof mcpSdk.createMCPClient>>>();

    const createMCPClientSpy = spyOn(mcpSdk, "createMCPClient").mockImplementation(() => {
      controller.abort();
      return createClient.promise;
    });

    try {
      const startup = access.startSingleServerImpl(
        "http-late-client-cleanup",
        { transport: "http", url: "https://example.com/mcp" },
        {} as Runtime,
        "/tmp/project",
        "/tmp/workspace",
        undefined,
        () => undefined,
        controller.signal
      );

      createClient.resolve({
        close: lateClientClose,
        tools: mock(() => Promise.resolve({})),
      } as unknown as Awaited<ReturnType<typeof mcpSdk.createMCPClient>>);

      const result = await startup;

      expect(result).toBeNull();
      expect(lateClientClose).toHaveBeenCalledTimes(1);
    } finally {
      createMCPClientSpy.mockRestore();
    }
  });

  test("getToolsForWorkspace tracks failed server names in stats", async () => {
    const workspaceId = "ws-failed-names";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock(() =>
      Promise.resolve({
        "healthy-server": { transport: "stdio", command: "ok", disabled: false },
        "broken-server": { transport: "stdio", command: "bad", disabled: false },
      })
    );

    const close = mock(() => Promise.resolve(undefined));
    access.startSingleServerImpl = mock((name: unknown) => {
      if (name === "broken-server") {
        return Promise.reject(new Error("invalid MCP server config"));
      }

      return Promise.resolve({
        name: String(name),
        resolvedTransport: "stdio",
        autoFallbackUsed: false,
        tools: {},
        isClosed: false,
        close,
      });
    });

    const result = await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(result.stats.failedServerCount).toBe(1);
    expect(result.stats.failedServerNames).toContain("broken-server");
  });

  test("getToolsForWorkspace retries timed-out servers from cached workspace state", async () => {
    const workspaceId = "ws-timeout-retry";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: { transport: "stdio", command: "cmd-a", disabled: false },
        serverB: { transport: "stdio", command: "cmd-b", disabled: false },
      })
    );

    const toolA = { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool;
    const toolB = { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool;

    const startServersMock = mock((servers: unknown) => {
      const serverMap = servers as Record<string, unknown>;
      if (startServersMock.mock.calls.length === 1) {
        expect(Object.keys(serverMap)).toEqual(["serverA", "serverB"]);
        return Promise.resolve({
          instances: new Map([
            [
              "serverA",
              {
                name: "serverA",
                resolvedTransport: "stdio",
                autoFallbackUsed: false,
                tools: { toolA },
                isClosed: false,
                close: mock(() => Promise.resolve(undefined)),
              },
            ],
          ]),
          failedServerNames: ["serverB"],
          timedOutServerNames: ["serverB"],
        });
      }

      expect(Object.keys(serverMap)).toEqual(["serverB"]);
      return Promise.resolve({
        instances: new Map([
          [
            "serverB",
            {
              name: "serverB",
              resolvedTransport: "stdio",
              autoFallbackUsed: false,
              tools: { toolB },
              isClosed: false,
              close: mock(() => Promise.resolve(undefined)),
            },
          ],
        ]),
        failedServerNames: [],
        timedOutServerNames: [],
      });
    });

    access.startServers = startServersMock;

    const initial = await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(initial.stats.failedServerCount).toBe(1);
    expect(initial.stats.failedServerNames).toEqual(["serverB"]);
    expect(initial.stats.startedServerCount).toBe(1);
    expect(Object.keys(initial.tools)).toEqual(["servera_toola"]);

    const retried = await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(startServersMock).toHaveBeenCalledTimes(2);
    expect(retried.stats.failedServerCount).toBe(0);
    expect(retried.stats.failedServerNames).toEqual([]);
    expect(retried.stats.startedServerCount).toBe(2);
    const retriedToolNames = Object.keys(retried.tools);
    expect(retriedToolNames).toContain("servera_toola");
    expect(retriedToolNames).toContain("serverb_toolb");

    const cached = access.workspaceServers.get(workspaceId) as {
      timedOutServerNames?: string[];
    };
    expect(cached.timedOutServerNames).toEqual([]);
  });

  test("getToolsForWorkspace does not overlap timed-out retries for concurrent cached requests", async () => {
    const workspaceId = "ws-timeout-retry-concurrent";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock(() =>
      Promise.resolve({
        slow: { transport: "stdio", command: "cmd-slow", disabled: false },
      })
    );

    const retryStarted = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<{
      instances: Map<string, unknown>;
      failedServerNames: string[];
      timedOutServerNames: string[];
    }>();
    let hasSignaledRetryStart = false;

    const slowTool = { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool;
    const startServersMock = mock(() => {
      if (!hasSignaledRetryStart) {
        hasSignaledRetryStart = true;
        retryStarted.resolve();
      }

      return retryFinished.promise;
    });
    access.startServers = startServersMock;

    access.workspaceServers.set(workspaceId, {
      configSignature: JSON.stringify({
        slow: { transport: "stdio", command: "cmd-slow" },
      }),
      instances: new Map(),
      stats: {
        enabledServerCount: 1,
        startedServerCount: 0,
        failedServerCount: 1,
        autoFallbackCount: 0,
        failedServerNames: ["slow"],
        hasStdio: false,
        hasHttp: false,
        hasSse: false,
        transportMode: "none",
      },
      timedOutServerNames: ["slow"],
      lastActivity: Date.now(),
    });

    const firstPromise = manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });
    await retryStarted.promise;

    const secondPromise = manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(startServersMock).toHaveBeenCalledTimes(1);

    retryFinished.resolve({
      instances: new Map([
        [
          "slow",
          {
            name: "slow",
            resolvedTransport: "stdio",
            autoFallbackUsed: false,
            tools: { tool: slowTool },
            isClosed: false,
            close: mock(() => Promise.resolve(undefined)),
          },
        ],
      ]),
      failedServerNames: [],
      timedOutServerNames: [],
    });

    const [first] = await Promise.all([firstPromise, secondPromise]);

    expect(startServersMock).toHaveBeenCalledTimes(1);
    expect(first.stats.failedServerCount).toBe(0);
    expect(Object.keys(first.tools)).toEqual(["slow_tool"]);

    const cached = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, unknown>;
      timedOutServerNames?: string[];
      retryingTimedOutServerNames?: Set<string>;
    };
    expect(cached.instances.has("slow")).toBe(true);
    expect(cached.timedOutServerNames).toEqual([]);
    expect(cached.retryingTimedOutServerNames?.size).toBe(0);
  });

  test("getToolsForWorkspace closes timed-out retry results when cache entry is replaced mid-retry", async () => {
    const workspaceId = "ws-timeout-retry-replaced";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        slow: { transport: "stdio", command, disabled: false },
      })
    );

    const retryStarted = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<{
      instances: Map<string, unknown>;
      failedServerNames: string[];
      timedOutServerNames: string[];
    }>();
    let startServersCallCount = 0;

    const retriedClose = mock(() => Promise.resolve(undefined));
    const replacementClose = mock(() => Promise.resolve(undefined));
    const retriedInstance = {
      name: "slow",
      resolvedTransport: "stdio",
      autoFallbackUsed: false,
      tools: { retry: { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool },
      isClosed: false,
      close: retriedClose,
    };
    const replacementInstance = {
      name: "slow",
      resolvedTransport: "stdio",
      autoFallbackUsed: false,
      tools: { active: { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool },
      isClosed: false,
      close: replacementClose,
    };

    const startServersMock = mock((servers: unknown) => {
      startServersCallCount += 1;
      const serverMap = servers as Record<string, { command?: string }>;

      if (startServersCallCount === 1) {
        expect(Object.keys(serverMap)).toEqual(["slow"]);
        expect(serverMap.slow?.command).toBe("cmd-1");
        retryStarted.resolve();
        return retryFinished.promise;
      }

      expect(Object.keys(serverMap)).toEqual(["slow"]);
      expect(serverMap.slow?.command).toBe("cmd-2");
      return Promise.resolve({
        instances: new Map([["slow", replacementInstance]]),
        failedServerNames: [],
        timedOutServerNames: [],
      });
    });
    access.startServers = startServersMock;

    const staleEntry = {
      configSignature: JSON.stringify({
        slow: { transport: "stdio", command: "cmd-1" },
      }),
      instances: new Map(),
      stats: {
        enabledServerCount: 1,
        startedServerCount: 0,
        failedServerCount: 1,
        autoFallbackCount: 0,
        failedServerNames: ["slow"],
        hasStdio: false,
        hasHttp: false,
        hasSse: false,
        transportMode: "none",
      },
      timedOutServerNames: ["slow"],
      retryingTimedOutServerNames: new Set<string>(),
      lastActivity: Date.now(),
    };
    access.workspaceServers.set(workspaceId, staleEntry);

    const retryPromise = manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });
    await retryStarted.promise;

    expect(staleEntry.retryingTimedOutServerNames.has("slow")).toBe(true);

    command = "cmd-2";
    const replacementResult = await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(Object.keys(replacementResult.tools)).toEqual(["slow_active"]);

    retryFinished.resolve({
      instances: new Map([["slow", retriedInstance]]),
      failedServerNames: [],
      timedOutServerNames: [],
    });

    const retriedResult = await retryPromise;

    expect(startServersMock).toHaveBeenCalledTimes(2);
    expect(retriedClose).toHaveBeenCalledTimes(1);
    expect(replacementClose).toHaveBeenCalledTimes(0);
    expect(Object.keys(retriedResult.tools)).toEqual(["slow_active"]);

    const activeEntry = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, typeof replacementInstance>;
      retryingTimedOutServerNames?: Set<string>;
    };
    expect(activeEntry).not.toBe(staleEntry);
    expect(activeEntry.instances.get("slow")).toBe(replacementInstance);
    expect(activeEntry.retryingTimedOutServerNames?.size).toBe(0);
    expect(staleEntry.instances.size).toBe(0);
    expect(staleEntry.retryingTimedOutServerNames.size).toBe(0);
  });

  test("getToolsForWorkspace defers restarts while leased and applies them on next request", async () => {
    const workspaceId = "ws-defer";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { transport: "stdio", command, disabled: false },
      })
    );

    const close = mock(() => Promise.resolve(undefined));

    const dummyTool = {
      execute: mock(() => Promise.resolve({ ok: true })),
    } as unknown as Tool;

    const startServersMock = mock(() =>
      Promise.resolve({
        instances: new Map([
          [
            "server",
            {
              name: "server",
              resolvedTransport: "stdio",
              autoFallbackUsed: false,
              tools: { tool: dummyTool },
              isClosed: false,
              close,
            },
          ],
        ]),
        failedServerNames: [],
      })
    );

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    manager.acquireLease(workspaceId);

    // Change signature while leased.
    command = "cmd-2";

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(startServersMock).toHaveBeenCalledTimes(1);

    manager.releaseLease(workspaceId);

    // No automatic restart on lease release (avoids closing clients out from under a
    // subsequent stream that already captured the tool objects).
    expect(access.workspaceServers.has(workspaceId)).toBe(true);
    expect(close).toHaveBeenCalledTimes(0);

    // Next request (no lease) applies the pending restart.
    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(startServersMock).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("getToolsForWorkspace restarts when cached instances are marked closed", async () => {
    const workspaceId = "ws-closed";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock(() =>
      Promise.resolve({
        server: { transport: "stdio", command: "cmd", disabled: false },
      })
    );

    const close1 = mock(() => Promise.resolve(undefined));
    const close2 = mock(() => Promise.resolve(undefined));

    let startCount = 0;
    const startServersMock = mock(() => {
      startCount += 1;
      return Promise.resolve({
        instances: new Map([
          [
            "server",
            {
              name: "server",
              resolvedTransport: "stdio",
              autoFallbackUsed: false,
              tools: {},
              isClosed: false,
              close: startCount === 1 ? close1 : close2,
            },
          ],
        ]),
        failedServerNames: [],
      });
    });

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    // Simulate an active stream lease.
    manager.acquireLease(workspaceId);

    const cached = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, { isClosed: boolean }>;
    };

    const instance = cached.instances.get("server");
    expect(instance).toBeTruthy();
    if (instance) {
      instance.isClosed = true;
    }

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(startServersMock).toHaveBeenCalledTimes(2);
    expect(close1).toHaveBeenCalledTimes(1);
  });

  test("getToolsForWorkspace does not close healthy instances when restarting closed ones while leased", async () => {
    const workspaceId = "ws-closed-partial";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: { transport: "stdio", command: "cmd-a", disabled: false },
        serverB: { transport: "stdio", command: "cmd-b", disabled: false },
      })
    );

    const closeA1 = mock(() => Promise.resolve(undefined));
    const closeA2 = mock(() => Promise.resolve(undefined));
    const closeB1 = mock(() => Promise.resolve(undefined));

    let startCount = 0;
    const startServersMock = mock(() => {
      startCount += 1;

      if (startCount === 1) {
        return Promise.resolve({
          instances: new Map([
            [
              "serverA",
              {
                name: "serverA",
                resolvedTransport: "stdio",
                autoFallbackUsed: false,
                tools: {},
                isClosed: false,
                close: closeA1,
              },
            ],
            [
              "serverB",
              {
                name: "serverB",
                resolvedTransport: "stdio",
                autoFallbackUsed: false,
                tools: {},
                isClosed: false,
                close: closeB1,
              },
            ],
          ]),
          failedServerNames: [],
        });
      }

      return Promise.resolve({
        instances: new Map([
          [
            "serverA",
            {
              name: "serverA",
              resolvedTransport: "stdio",
              autoFallbackUsed: false,
              tools: {},
              isClosed: false,
              close: closeA2,
            },
          ],
        ]),
        failedServerNames: [],
      });
    });

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    // Simulate an active stream lease.
    manager.acquireLease(workspaceId);

    const cached = access.workspaceServers.get(workspaceId) as {
      instances: Map<string, { isClosed: boolean }>;
    };

    const instanceA = cached.instances.get("serverA");
    expect(instanceA).toBeTruthy();
    if (instanceA) {
      instanceA.isClosed = true;
    }

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    // Restart should only close the dead instance.
    expect(closeA1).toHaveBeenCalledTimes(1);
    expect(closeB1).toHaveBeenCalledTimes(0);
  });

  test("getToolsForWorkspace does not return tools from newly-disabled servers while leased", async () => {
    const workspaceId = "ws-disable-while-leased";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: { transport: "stdio", command: "cmd-a", disabled: false },
        serverB: { transport: "stdio", command: "cmd-b", disabled: false },
      })
    );

    const dummyToolA = { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool;
    const dummyToolB = { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool;

    const startServersMock = mock(() =>
      Promise.resolve({
        instances: new Map([
          [
            "serverA",
            {
              name: "serverA",
              resolvedTransport: "stdio",
              autoFallbackUsed: false,
              tools: { tool: dummyToolA },
              isClosed: false,
              close: mock(() => Promise.resolve(undefined)),
            },
          ],
          [
            "serverB",
            {
              name: "serverB",
              resolvedTransport: "stdio",
              autoFallbackUsed: false,
              tools: { tool: dummyToolB },
              isClosed: false,
              close: mock(() => Promise.resolve(undefined)),
            },
          ],
        ]),
        failedServerNames: [],
      })
    );

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    manager.acquireLease(workspaceId);

    const toolsResult = await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
      overrides: {
        disabledServers: ["serverB"],
      },
    });

    // Tool names are normalized to provider-safe keys (lowercase + underscore-delimited).
    expect(Object.keys(toolsResult.tools)).toContain("servera_tool");
    expect(Object.keys(toolsResult.tools)).not.toContain("serverb_tool");
  });

  test("getToolsForWorkspace filters disabled-server failures from leased stats", async () => {
    const workspaceId = "ws-disable-failed-while-leased";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: { transport: "stdio", command: "cmd-a", disabled: false },
        serverB: { transport: "stdio", command: "cmd-b", disabled: false },
      })
    );

    const dummyToolA = { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool;

    const startServersMock = mock(() =>
      Promise.resolve(
        new Map([
          [
            "serverA",
            {
              name: "serverA",
              resolvedTransport: "stdio",
              autoFallbackUsed: false,
              tools: { tool: dummyToolA },
              isClosed: false,
              close: mock(() => Promise.resolve(undefined)),
            },
          ],
        ])
      )
    );

    access.startServers = startServersMock;

    const initial = await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

    expect(initial.stats.failedServerCount).toBe(1);

    manager.acquireLease(workspaceId);

    const leased = await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
      overrides: {
        disabledServers: ["serverB"],
      },
    });

    expect(startServersMock).toHaveBeenCalledTimes(1);
    expect(leased.stats.failedServerCount).toBe(0);
    expect(Object.keys(leased.tools)).toEqual(["servera_tool"]);
  });

  test("getToolsForWorkspace only exposes repo-defined servers for trusted projects", async () => {
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock((_projectPath: string, trusted?: boolean) =>
      Promise.resolve(
        trusted
          ? {
              global: { transport: "stdio", command: "global-cmd", disabled: false },
              repo: { transport: "stdio", command: "repo-cmd", disabled: false },
            }
          : {
              global: { transport: "stdio", command: "global-cmd", disabled: false },
            }
      )
    );

    const startServersMock = mock((servers: Record<string, unknown>) =>
      Promise.resolve(
        new Map(
          Object.keys(servers).map((name) => [
            name,
            {
              name,
              resolvedTransport: "stdio",
              autoFallbackUsed: false,
              tools: {
                tool: { execute: mock(() => Promise.resolve({ ok: true })) } as unknown as Tool,
              },
              isClosed: false,
              close: mock(() => Promise.resolve(undefined)),
            },
          ])
        )
      )
    );

    access.startServers = startServersMock as unknown as typeof access.startServers;

    const runtime = {} satisfies Partial<Runtime>;

    const untrustedResult = await manager.getToolsForWorkspace({
      workspaceId: "ws-untrusted-mcp",
      projectPath,
      runtime: runtime as Runtime,
      workspacePath,
      trusted: false,
    });

    const trustedResult = await manager.getToolsForWorkspace({
      workspaceId: "ws-trusted-mcp",
      projectPath,
      runtime: runtime as Runtime,
      workspacePath,
      trusted: true,
    });

    expect(configService.listServers).toHaveBeenNthCalledWith(1, projectPath, false);
    expect(configService.listServers).toHaveBeenNthCalledWith(2, projectPath, true);
    expect(Object.keys(untrustedResult.tools)).toEqual(["global_tool"]);
    expect(Object.keys(trustedResult.tools).sort()).toEqual(["global_tool", "repo_tool"]);

    const firstStartedServers = startServersMock.mock.calls[0]?.[0];
    const secondStartedServers = startServersMock.mock.calls[1]?.[0];
    expect(Object.keys(firstStartedServers ?? {})).toEqual(["global"]);
    expect(Object.keys(secondStartedServers ?? {}).sort()).toEqual(["global", "repo"]);
  });
  test("test() includes oauthChallenge when server responds 401 + WWW-Authenticate Bearer", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";

    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
      );
      res.end("Unauthorized");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind OAuth challenge test server");
      }

      baseUrl = `http://127.0.0.1:${address.port}/`;
      resourceMetadataUrl = `${baseUrl}.well-known/oauth-protected-resource`;

      const result = await manager.test({
        projectPath: "/tmp/project",
        transport: "http",
        url: baseUrl,
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected test() to fail");
      }

      expect(result.oauthChallenge).toEqual({
        scope: "mcp.read",
        resourceMetadataUrl,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("tool execution failure with closed-client error marks instance isClosed for restart", async () => {
    const workspaceId = "ws-tool-closed";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/workspace";

    configService.listServers = mock(() =>
      Promise.resolve({
        "test-server": { transport: "stdio", command: "cmd", disabled: false },
      })
    );

    const closedError = new Error("Attempted to send a request from a closed client");
    const dummyTool = {
      execute: mock(() => Promise.reject(closedError)),
      parameters: {},
    } as unknown as Tool;

    const startServersMock = mock(() => {
      const tools: Record<string, Tool> = {};
      const instance = {
        name: "test-server",
        resolvedTransport: "stdio" as const,
        autoFallbackUsed: false,
        tools,
        isClosed: false,
        close: mock(() => Promise.resolve(undefined)),
      };

      instance.tools = wrapMCPTools(
        { failTool: dummyTool },
        {
          onClosed: () => {
            instance.isClosed = true;
          },
        }
      );

      return Promise.resolve({
        instances: new Map([["test-server", instance]]),
        failedServerNames: [],
      });
    });

    access.startServers = startServersMock;

    const result1 = await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });
    expect(startServersMock).toHaveBeenCalledTimes(1);

    const firstTool = Object.values(result1.tools)[0];
    expect(firstTool).toBeDefined();
    if (!firstTool?.execute) {
      throw new Error("Expected wrapped MCP tool to include execute");
    }

    let firstToolError: unknown;
    try {
      await firstTool.execute({}, {} as never);
    } catch (error) {
      firstToolError = error;
    }
    expect(firstToolError).toBe(closedError);

    const cached = access.workspaceServers.get(workspaceId) as
      | { instances: Map<string, { isClosed: boolean }> }
      | undefined;

    expect(cached).toBeDefined();

    const instances = cached?.instances;
    expect(instances).toBeDefined();
    for (const [, inst] of instances ?? []) {
      expect(inst.isClosed).toBe(true);
    }

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });
    expect(startServersMock).toHaveBeenCalledTimes(2);
  });
});

describe("isClosedClientError", () => {
  test("returns true for 'Attempted to send a request from a closed client'", () => {
    expect(isClosedClientError(new Error("Attempted to send a request from a closed client"))).toBe(
      true
    );
  });

  test("returns true for 'Connection closed'", () => {
    expect(isClosedClientError(new Error("Connection closed"))).toBe(true);
  });

  test("returns true for 'MCP SSE Transport Error: Connection closed unexpectedly'", () => {
    expect(
      isClosedClientError(new Error("MCP SSE Transport Error: Connection closed unexpectedly"))
    ).toBe(true);
  });

  test("returns true for 'Not connected'", () => {
    expect(isClosedClientError(new Error("MCP SSE Transport Error: Not connected"))).toBe(true);
  });

  test("returns true for chained error with closed-client cause", () => {
    const cause = new Error("Connection closed");
    const wrapper = new Error("Tool execution failed", { cause });
    expect(isClosedClientError(wrapper)).toBe(true);
  });

  test("returns false for chained error without closed-client cause", () => {
    const cause = new Error("ECONNREFUSED");
    const wrapper = new Error("Tool execution failed", { cause });
    expect(isClosedClientError(wrapper)).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isClosedClientError(new Error("timeout"))).toBe(false);
    expect(isClosedClientError(new Error("ECONNREFUSED"))).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isClosedClientError(null)).toBe(false);
    expect(isClosedClientError(undefined)).toBe(false);
    expect(isClosedClientError("string error")).toBe(false);
  });
});

describe("wrapMCPTools", () => {
  test("calls onClosed when execute throws a closed-client error", async () => {
    const onClosed = mock(() => undefined);
    const closedError = new Error("Attempted to send a request from a closed client");
    const tool = {
      execute: mock(() => Promise.reject(closedError)),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });

    let executeError: unknown;
    try {
      await wrapped.myTool.execute!({}, {} as never);
    } catch (error) {
      executeError = error;
    }

    expect(executeError).toBe(closedError);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("does NOT call onClosed for non-closed-client errors", async () => {
    const onClosed = mock(() => undefined);
    const otherError = new Error("some other failure");
    const tool = {
      execute: mock(() => Promise.reject(otherError)),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });

    let executeError: unknown;
    try {
      await wrapped.myTool.execute!({}, {} as never);
    } catch (error) {
      executeError = error;
    }

    expect(executeError).toBe(otherError);
    expect(onClosed).toHaveBeenCalledTimes(0);
  });

  test("wraps multiple tools and failure in one does not affect others", async () => {
    const onClosed = mock(() => undefined);
    const failTool = {
      execute: mock(() =>
        Promise.reject(new Error("Attempted to send a request from a closed client"))
      ),
      parameters: {},
    } as unknown as Tool;
    const okTool = {
      execute: mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] })),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ failTool, okTool }, { onClosed });

    // failTool should throw and trigger onClosed
    try {
      await wrapped.failTool.execute!({}, {} as never);
      throw new Error("Expected failTool to throw");
    } catch (e) {
      expect((e as Error).message).toBe("Attempted to send a request from a closed client");
    }
    expect(onClosed).toHaveBeenCalledTimes(1);

    // okTool should still work fine
    const result: unknown = await wrapped.okTool.execute!({}, {} as never);
    expect(result).toBeTruthy();
  });

  test("onClosed throwing does not mask original error", async () => {
    const onClosed = mock(() => {
      throw new Error("onClosed exploded");
    });
    const closedError = new Error("Attempted to send a request from a closed client");
    const tool = {
      execute: mock(() => Promise.reject(closedError)),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });
    try {
      await wrapped.myTool.execute!({}, {} as never);
      throw new Error("Expected to throw");
    } catch (e) {
      // Original error should be preserved, NOT the onClosed error
      expect(e).toBe(closedError);
    }
    // onClosed was still called (even though it threw)
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("calls onActivity before execute and still calls it on failure", async () => {
    const onActivity = mock(() => undefined);
    const onClosed = mock(() => undefined);
    const tool = {
      execute: mock(() =>
        Promise.reject(new Error("Attempted to send a request from a closed client"))
      ),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onActivity, onClosed });

    let didThrow = false;
    try {
      await wrapped.myTool.execute!({}, {} as never);
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  test("rejects with Interrupted when aborted during execution", async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<unknown>();
    const tool = {
      execute: mock(() => pending.promise),
      parameters: {},
    } as unknown as Tool;

    const onClosed = mock(() => undefined);
    const wrapped = wrapMCPTools({ hangTool: tool }, { onClosed });

    const promise = wrapped.hangTool.execute!({}, {
      abortSignal: controller.signal,
    } as never) as Promise<unknown>;
    controller.abort();

    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect((caught as Error).name).toBe("MCPDeadlineError");
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("rejects immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const executeMock = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const tool = {
      execute: executeMock,
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool });
    const promise = wrapped.myTool.execute!({}, {
      abortSignal: controller.signal,
    } as never) as Promise<unknown>;
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect(executeMock).not.toHaveBeenCalled();
  });

  test("does NOT call onClosed for upstream error containing 'timed out'", async () => {
    const onClosed = mock(() => undefined);
    const timeoutError = new Error("upstream request timed out");
    const tool = {
      execute: mock(() => Promise.reject(timeoutError)),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });

    const promise = wrapped.myTool.execute!({}, {} as never) as Promise<unknown>;
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("upstream request timed out");
    expect(onClosed).not.toHaveBeenCalled();
  });

  test("runMCPToolWithDeadline rejects with MCPDeadlineError after timeout", async () => {
    const { promise } = Promise.withResolvers<unknown>();

    let caught: unknown;
    try {
      await runMCPToolWithDeadline(() => promise, {
        toolName: "slowTool",
        timeoutMs: 50,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("timed out");
    expect((caught as Error).message).toContain("slowTool");
    expect((caught as Error).name).toBe("MCPDeadlineError");
  });

  test("runMCPToolWithDeadline skips start when pre-aborted", async () => {
    const startFn = mock(() => Promise.resolve("should not run"));
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await runMCPToolWithDeadline(startFn, {
        toolName: "test",
        timeoutMs: 300_000,
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect(startFn).not.toHaveBeenCalled();
  });

  test("runMCPToolWithDeadline clears timeout when abort wins", async () => {
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      const { promise } = Promise.withResolvers<unknown>();
      const controller = new AbortController();

      // Start the deadline race with a hung promise, then abort.
      const resultPromise = runMCPToolWithDeadline(() => promise, {
        toolName: "hangingTool",
        timeoutMs: 300_000,
        signal: controller.signal,
      });
      controller.abort();

      let caught: unknown;
      try {
        await resultPromise;
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("Interrupted");
      // The timeout timer must be cleared eagerly when abort wins —
      // not left dangling for 5 minutes.
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  test("passes through successful execution results", async () => {
    const tool = {
      execute: mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] })),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool });
    const result: unknown = await wrapped.myTool.execute!({}, {} as never);
    expect(result).toBeTruthy();
  });

  test("skips wrapping tools without execute", () => {
    const tool = {
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ noExec: tool });
    expect(wrapped.noExec).toBe(tool);
  });
});
