import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createServer } from "http";

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
        return Promise.resolve(
          new Map([
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
          ])
        );
      }

      return Promise.resolve(
        new Map([
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

      return Promise.resolve(new Map([["test-server", instance]]));
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
