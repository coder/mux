import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as net from "net";
import { ServerService, computeNetworkBaseUrls } from "./serverService";
import type { ORPCContext } from "@/node/orpc/context";
import { Config } from "@/node/config";
import { ServerLockDataSchema } from "./serverLockfile";

describe("ServerService", () => {
  test("initializes with null path", async () => {
    const service = new ServerService();
    expect(await service.getLaunchProject()).toBeNull();
  });

  test("sets and gets project path", async () => {
    const service = new ServerService();
    service.setLaunchProject("/test/path");
    expect(await service.getLaunchProject()).toBe("/test/path");
  });

  test("updates project path", async () => {
    const service = new ServerService();
    service.setLaunchProject("/path/1");
    expect(await service.getLaunchProject()).toBe("/path/1");
    service.setLaunchProject("/path/2");
    expect(await service.getLaunchProject()).toBe("/path/2");
  });

  test("clears project path", async () => {
    const service = new ServerService();
    service.setLaunchProject("/test/path");
    expect(await service.getLaunchProject()).toBe("/test/path");
    service.setLaunchProject(null);
    expect(await service.getLaunchProject()).toBeNull();
  });
});

describe("ServerService.startServer", () => {
  let tempDir: string;

  let stubContext: ORPCContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-server-test-"));
    const config = new Config(tempDir);
    stubContext = { config } as unknown as ORPCContext;
  });

  afterEach(async () => {
    // Restore permissions before cleanup
    try {
      await fs.chmod(tempDir, 0o755);
    } catch {
      // ignore
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Check if a port is in use by attempting to connect to it */
  async function isPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(100);
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => {
        resolve(false);
      });
      socket.connect(port, "127.0.0.1");
    });
  }

  test("cleans up server when lockfile acquisition fails", async () => {
    // Skip on Windows where chmod doesn't work the same way
    if (process.platform === "win32") {
      return;
    }

    const service = new ServerService();

    // Make muxHome read-only so lockfile.acquire() will fail
    await fs.chmod(tempDir, 0o444);

    let thrownError: Error | null = null;

    try {
      // Start server - this should fail when trying to write lockfile
      await service.startServer({
        muxHome: tempDir,
        context: stubContext,
        authToken: "test-token",
        port: 0, // random port
      });
    } catch (err) {
      thrownError = err as Error;
    }

    // Verify that an error was thrown
    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toMatch(/EACCES|permission denied/i);

    // Verify the server is NOT left running
    expect(service.isServerRunning()).toBe(false);
    expect(service.getServerInfo()).toBeNull();
  });

  test("does not delete another process's lockfile when start fails", async () => {
    const service = new ServerService();

    // Create a lockfile simulating another running server (use our own PID so it appears "alive")
    const lockPath = path.join(tempDir, "server.lock");
    const existingLockData = {
      pid: process.pid,
      baseUrl: "http://127.0.0.1:9999",
      token: "other-server-token",
      startedAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(existingLockData, null, 2));

    // Try to start - should fail due to existing server
    let thrownError: Error | null = null;
    try {
      await service.startServer({
        muxHome: tempDir,
        context: stubContext,
        authToken: "test-token",
        port: 0,
      });
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).toMatch(/already running/i);

    // Critical: call stopServer (simulating cleanup in finally block)
    await service.stopServer();

    // Verify the OTHER process's lockfile was NOT deleted
    const lockContent = await fs.readFile(lockPath, "utf-8");
    const lockData = ServerLockDataSchema.parse(JSON.parse(lockContent));
    expect(lockData.baseUrl).toBe("http://127.0.0.1:9999");
    expect(lockData.token).toBe("other-server-token");
  });

  test("successful start creates lockfile and server", async () => {
    const service = new ServerService();

    const info = await service.startServer({
      muxHome: tempDir,
      context: stubContext,
      authToken: "test-token",
      port: 0,
    });

    try {
      expect(info.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(info.token).toBe("test-token");
      expect(service.isServerRunning()).toBe(true);

      // Verify lockfile was created
      const lockPath = path.join(tempDir, "server.lock");
      const lockContent = await fs.readFile(lockPath, "utf-8");
      const lockData = ServerLockDataSchema.parse(JSON.parse(lockContent));
      expect(lockData.baseUrl).toBe(info.baseUrl);
      expect(lockData.token).toBe("test-token");

      // Verify server is actually listening
      const port = parseInt(info.baseUrl.split(":")[2], 10);
      expect(await isPortListening(port)).toBe(true);
    } finally {
      await service.stopServer();
    }
  });
});

describe("computeNetworkBaseUrls", () => {
  test("returns empty for loopback binds", () => {
    expect(computeNetworkBaseUrls({ bindHost: "127.0.0.1", port: 3000 })).toEqual([]);
    expect(computeNetworkBaseUrls({ bindHost: "127.0.0.2", port: 3000 })).toEqual([]);
    expect(computeNetworkBaseUrls({ bindHost: "localhost", port: 3000 })).toEqual([]);
    expect(computeNetworkBaseUrls({ bindHost: "::1", port: 3000 })).toEqual([]);
  });

  test("expands 0.0.0.0 to all non-internal IPv4 interfaces", () => {
    const networkInterfaces: ReturnType<typeof os.networkInterfaces> = {
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.10/24",
        },
      ],
      tailscale0: [
        {
          address: "100.64.0.2",
          netmask: "255.192.0.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:01",
          internal: false,
          cidr: "100.64.0.2/10",
        },
      ],
      docker0: [
        {
          address: "169.254.1.2",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:02",
          internal: false,
          cidr: "169.254.1.2/16",
        },
      ],
    };

    expect(
      computeNetworkBaseUrls({
        bindHost: "0.0.0.0",
        port: 3000,
        networkInterfaces,
      })
    ).toEqual(["http://100.64.0.2:3000", "http://192.168.1.10:3000"]);
  });

  test("formats IPv6 URLs with brackets", () => {
    const networkInterfaces: ReturnType<typeof os.networkInterfaces> = {
      en0: [
        {
          address: "fd7a:115c:a1e0::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "fd7a:115c:a1e0::1/64",
          scopeid: 0,
        },
        {
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          family: "IPv6",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "fe80::1/64",
          scopeid: 0,
        },
      ],
    };

    expect(
      computeNetworkBaseUrls({
        bindHost: "::",
        port: 3000,
        networkInterfaces,
      })
    ).toEqual(["http://[fd7a:115c:a1e0::1]:3000"]);

    expect(computeNetworkBaseUrls({ bindHost: "2001:db8::1", port: 3000 })).toEqual([
      "http://[2001:db8::1]:3000",
    ]);
  });
});
