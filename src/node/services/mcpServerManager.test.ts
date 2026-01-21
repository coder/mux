import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { MCPServerManager } from "./mcpServerManager";
import type { MCPConfigService } from "./mcpConfigService";
import type { Runtime } from "@/node/runtime/Runtime";
import type { Tool } from "ai";

interface MCPServerManagerTestAccess {
  workspaceServers: Map<string, unknown>;
  cleanupIdleServers: () => void;
  startServers: (...args: unknown[]) => Promise<Map<string, unknown>>;
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

  test("releaseLease triggers a deferred restart when pendingRestart is set", () => {
    const workspaceId = "ws-pending-restart";

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
        hasStdio: true,
        hasHttp: false,
        hasSse: false,
        transportMode: "stdio_only",
      },
      lastActivity: Date.now(),
      pendingRestart: true,
    };

    access.workspaceServers.set(workspaceId, entry);

    manager.acquireLease(workspaceId);
    manager.releaseLease(workspaceId);

    expect(access.workspaceServers.has(workspaceId)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("getToolsForWorkspace defers restarts while leased and applies them on release", async () => {
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
      Promise.resolve(
        new Map([
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
        ])
      )
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

    const deferredEntry = access.workspaceServers.get(workspaceId) as { pendingRestart?: boolean };
    expect(deferredEntry.pendingRestart).toBe(true);

    manager.releaseLease(workspaceId);

    expect(access.workspaceServers.has(workspaceId)).toBe(false);
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
      return Promise.resolve(
        new Map([
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
        ])
      );
    });

    access.startServers = startServersMock;

    await manager.getToolsForWorkspace({
      workspaceId,
      projectPath,
      runtime: {} as unknown as Runtime,
      workspacePath,
    });

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
});
