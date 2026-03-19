import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { BrowserSessionAttachmentStore } from "@/node/services/browserSessionAttachmentStore";
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

  test("keeps in-memory reservations when attachment persistence fails", async () => {
    const attachmentStore = {
      getAttachment: mock(() => null),
      writeAttachment: mock(() => {
        throw new Error("disk full");
      }),
      deleteAttachment: mock(() => undefined),
    };
    const registry = new BrowserSessionStreamPortRegistry({ attachmentStore });

    const reservedPort = await registry.reservePort("workspace-persist-failure");

    expect(reservedPort).toBeGreaterThan(0);
    expect(registry.isReservedPort("workspace-persist-failure", reservedPort)).toBe(true);
  });

  test("loads persisted stream ports after a Mux restart and clears them on release", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-browser-port-registry-"));
    try {
      const attachmentStore = new BrowserSessionAttachmentStore(tempDir);
      attachmentStore.writeAttachment("workspace-persisted", 45678);
      const registry = new BrowserSessionStreamPortRegistry({ attachmentStore });

      expect(registry.getReservedPort("workspace-persisted")).toBeNull();
      expect(registry.getKnownPort("workspace-persisted")).toBe(45678);

      const reservedPort = await registry.reservePort("workspace-persisted");

      expect(reservedPort).toBe(45678);
      expect(registry.isReservedPort("workspace-persisted", 45678)).toBe(true);

      registry.releasePort("workspace-persisted");
      expect(attachmentStore.getAttachment("workspace-persisted")).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
