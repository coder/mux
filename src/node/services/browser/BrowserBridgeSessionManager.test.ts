import { describe, expect, mock, test } from "bun:test";
import { BrowserBridgeSessionManager } from "./BrowserBridgeSessionManager";

function createStreamPortRegistry(ports: number[]) {
  const reserved = new Map<string, number>();
  const reservePort = mock<(workspaceId: string) => Promise<number>>((workspaceId: string) => {
    const existing = reserved.get(workspaceId);
    if (existing != null) {
      return Promise.resolve(existing);
    }
    const nextPort = ports.shift();
    if (nextPort == null) {
      return Promise.reject(new Error("No more ports available"));
    }
    reserved.set(workspaceId, nextPort);
    return Promise.resolve(nextPort);
  });
  const releasePort = mock((workspaceId: string) => {
    reserved.delete(workspaceId);
  });
  const isReservedPort = mock(
    (workspaceId: string, port: number) => reserved.get(workspaceId) === port
  );
  const getKnownPort = mock((workspaceId: string) => reserved.get(workspaceId) ?? null);

  return {
    reservePort,
    releasePort,
    isReservedPort,
    getKnownPort,
  };
}

describe("BrowserBridgeSessionManager", () => {
  test("ensureStarted opens a new mux-managed session when none exists", async () => {
    const streamPortRegistry = createStreamPortRegistry([9222]);
    const hasSession = mock(() => Promise.resolve(false));
    const openSession = mock(() => Promise.resolve({ success: true as const }));
    const closeSession = mock(() => Promise.resolve({ success: true }));
    const waitForStreamPort = mock(() => Promise.resolve({ ok: true as const }));
    const manager = new BrowserBridgeSessionManager({
      streamPortRegistry,
      hasAgentBrowserSessionFn: hasSession,
      openAgentBrowserSessionFn: openSession,
      closeAgentBrowserSessionFn: closeSession,
      waitForStreamPortFn: waitForStreamPort,
    });

    const connection = await manager.ensureStarted("workspace-1", {
      initialUrl: "https://example.com",
    });

    expect(connection).toEqual({
      workspaceId: "workspace-1",
      sessionId: "mux-workspace-1",
      streamPort: 9222,
    });
    expect(openSession).toHaveBeenCalledWith("mux-workspace-1", "https://example.com", {
      streamPort: 9222,
    });
    expect(waitForStreamPort).toHaveBeenCalledWith(9222);
  });

  test("ensureStarted restarts once when an existing session is attached to a stale stream port", async () => {
    const streamPortRegistry = createStreamPortRegistry([9222, 9333]);
    const hasSession = mock().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const openSession = mock(() => Promise.resolve({ success: true as const }));
    const closeSession = mock(() => Promise.resolve({ success: true }));
    const waitForStreamPort = mock()
      .mockResolvedValueOnce({ ok: false as const, error: "connect ECONNREFUSED" })
      .mockResolvedValueOnce({ ok: true as const });
    const manager = new BrowserBridgeSessionManager({
      streamPortRegistry,
      hasAgentBrowserSessionFn: hasSession,
      openAgentBrowserSessionFn: openSession,
      closeAgentBrowserSessionFn: closeSession,
      waitForStreamPortFn: waitForStreamPort,
    });

    const connection = await manager.ensureStarted("workspace-1");

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(streamPortRegistry.releasePort).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledWith("mux-workspace-1", "about:blank", {
      streamPort: 9333,
    });
    expect(connection.streamPort).toBe(9333);
  });

  test("stop cancels in-flight startup without closing a newer replacement session", async () => {
    const streamPortRegistry = createStreamPortRegistry([9222, 9333]);
    let waitCallCount = 0;
    let resolveSecondWait: (() => void) | null = null;
    let notifySecondWaitStarted: (() => void) | null = null;
    const secondWaitStarted = new Promise<void>((resolve) => {
      notifySecondWaitStarted = resolve;
    });
    const waitForStreamPort = mock(() => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return Promise.resolve({ ok: true as const });
      }

      notifySecondWaitStarted?.();
      return new Promise<{ ok: true }>((resolve) => {
        resolveSecondWait = () => resolve({ ok: true as const });
      });
    });
    const manager = new BrowserBridgeSessionManager({
      streamPortRegistry,
      hasAgentBrowserSessionFn: mock(() => Promise.resolve(false)),
      openAgentBrowserSessionFn: mock(() => Promise.resolve({ success: true as const })),
      closeAgentBrowserSessionFn: mock(() => Promise.resolve({ success: true })),
      waitForStreamPortFn: waitForStreamPort,
    });

    await manager.ensureStarted("workspace-1");
    await manager.stop("workspace-1");

    const secondStart = manager.ensureStarted("workspace-1");
    await secondWaitStarted;
    if (resolveSecondWait == null) {
      throw new Error("Expected second wait promise resolver to be registered");
    }
    resolveSecondWait();

    const secondConnection = await secondStart;

    expect(secondConnection).toEqual({
      workspaceId: "workspace-1",
      sessionId: "mux-workspace-1",
      streamPort: 9333,
    });
  });

  test("getLiveSessionConnection returns null without a known port or live session", async () => {
    const streamPortRegistry = createStreamPortRegistry([9222]);
    const manager = new BrowserBridgeSessionManager({
      streamPortRegistry,
      hasAgentBrowserSessionFn: mock(() => Promise.resolve(false)),
      openAgentBrowserSessionFn: mock(() => Promise.resolve({ success: true as const })),
      closeAgentBrowserSessionFn: mock(() => Promise.resolve({ success: true })),
      waitForStreamPortFn: mock(() => Promise.resolve({ ok: true as const })),
    });

    expect(await manager.getLiveSessionConnection("workspace-1")).toBeNull();
    await manager.ensureStarted("workspace-1");
    expect(await manager.getLiveSessionConnection("workspace-1")).toBeNull();
  });

  test("stop releases the reserved port even when close fails", async () => {
    const streamPortRegistry = createStreamPortRegistry([9222]);
    await streamPortRegistry.reservePort("workspace-1");
    const closeSession = mock(() =>
      Promise.resolve({ success: false, error: "permission denied" })
    );
    const manager = new BrowserBridgeSessionManager({
      streamPortRegistry,
      hasAgentBrowserSessionFn: mock(() => Promise.resolve(false)),
      openAgentBrowserSessionFn: mock(() => Promise.resolve({ success: true as const })),
      closeAgentBrowserSessionFn: closeSession,
      waitForStreamPortFn: mock(() => Promise.resolve({ ok: true as const })),
    });

    await manager.stop("workspace-1");

    expect(closeSession).toHaveBeenCalledWith("mux-workspace-1", undefined, undefined);
    expect(streamPortRegistry.releasePort).toHaveBeenCalledWith("workspace-1");
    expect(streamPortRegistry.getKnownPort("workspace-1")).toBeNull();
  });
});
