import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as net from "node:net";
import { BrowserSessionStreamPortRegistry } from "@/node/services/browserSessionStreamPortRegistry";

describe("BrowserSessionStreamPortRegistry", () => {
  afterEach(() => {
    mock.restore();
  });

  test("does not recreate a released reservation when an in-flight reserve resolves late", async () => {
    const registry = new BrowserSessionStreamPortRegistry();
    const listenState: { callback: (() => void) | null } = { callback: null };

    const server = {
      listen: (_port: number, _host: string, callback?: () => void) => {
        listenState.callback = callback ?? null;
        return server;
      },
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43210 }),
      close: (callback?: (error?: Error) => void) => {
        callback?.();
        return server;
      },
      on: (_event: string, _listener: (error: Error) => void) => server,
    } as unknown as net.Server;

    spyOn(net, "createServer").mockReturnValue(server);

    const pendingReservation = registry.reservePort("workspace-1");
    registry.releasePort("workspace-1");
    const triggerListen = listenState.callback;
    if (triggerListen == null) {
      throw new Error("Expected reservePort() to start listening for a free port");
    }
    triggerListen();

    let rejection: unknown;
    try {
      await pendingReservation;
      throw new Error("Expected the stale reservation to be cancelled");
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : String(rejection)).toBe(
      "Port reservation for workspace workspace-1 was cancelled"
    );
    expect(registry.getReservedPort("workspace-1")).toBeNull();
  });
});
