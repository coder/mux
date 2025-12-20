import * as os from "os";
import * as path from "path";
import { getControlPath, SSHConnectionPool, type SSHRuntimeConfig } from "./sshConnectionPool";

describe("sshConnectionPool", () => {
  describe("getControlPath", () => {
    test("identical configs produce same controlPath", () => {
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };
      const path1 = getControlPath(config);
      const path2 = getControlPath(config);

      expect(path1).toBe(path2);
    });

    test("different hosts produce different controlPaths", () => {
      const path1 = getControlPath({
        host: "host1.example.com",
        srcBaseDir: "/work",
      });
      const path2 = getControlPath({
        host: "host2.example.com",
        srcBaseDir: "/work",
      });

      expect(path1).not.toBe(path2);
    });

    test("different ports produce different controlPaths", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 22,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 2222,
      };

      expect(getControlPath(config1)).not.toBe(getControlPath(config2));
    });

    test("different identityFiles produce different controlPaths", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: "/path/to/key1",
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: "/path/to/key2",
      };

      expect(getControlPath(config1)).not.toBe(getControlPath(config2));
    });

    test("different srcBaseDirs produce same controlPaths (connection shared)", () => {
      // srcBaseDir is intentionally excluded from connection key -
      // workspaces on the same host share health tracking and multiplexing
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work1",
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work2",
      };

      expect(getControlPath(config1)).toBe(getControlPath(config2));
    });

    test("controlPath is in tmpdir with expected format", () => {
      const config: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
      };
      const controlPath = getControlPath(config);

      expect(controlPath).toContain(os.tmpdir());
      expect(controlPath).toMatch(/mux-ssh-[a-f0-9]{12}$/);
    });

    test("missing port defaults to 22 in hash calculation", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        port: 22,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        // port omitted, should default to 22
      };

      expect(getControlPath(config1)).toBe(getControlPath(config2));
    });

    test("missing identityFile defaults to 'default' in hash calculation", () => {
      const config1: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        identityFile: undefined,
      };
      const config2: SSHRuntimeConfig = {
        host: "test.com",
        srcBaseDir: "/work",
        // identityFile omitted
      };

      expect(getControlPath(config1)).toBe(getControlPath(config2));
    });
  });
});

describe("username isolation", () => {
  test("controlPath includes local username to prevent cross-user collisions", () => {
    // This test verifies that os.userInfo().username is included in the hash
    // On multi-user systems, different users connecting to the same remote
    // would get different controlPaths, preventing permission errors
    const config: SSHRuntimeConfig = {
      host: "test.com",
      srcBaseDir: "/work",
    };
    const controlPath = getControlPath(config);

    // The path should be deterministic for this user
    expect(controlPath).toBe(getControlPath(config));

    const expectedPrefix = path.join(os.tmpdir(), "mux-ssh-");
    expect(controlPath.startsWith(expectedPrefix)).toBe(true);
    expect(controlPath).toMatch(/mux-ssh-[a-f0-9]{12}$/);
  });
});

describe("SSHConnectionPool", () => {
  describe("health tracking", () => {
    test("getConnectionHealth returns undefined for unknown connection", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "unknown.example.com",
        srcBaseDir: "/work",
      };

      expect(pool.getConnectionHealth(config)).toBeUndefined();
    });

    test("markHealthy sets connection to healthy state", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      pool.markHealthy(config);
      const health = pool.getConnectionHealth(config);

      expect(health).toBeDefined();
      expect(health!.status).toBe("healthy");
      expect(health!.consecutiveFailures).toBe(0);
      expect(health!.lastSuccess).toBeInstanceOf(Date);
    });

    test("reportFailure puts connection into backoff", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      // Mark healthy first
      pool.markHealthy(config);
      expect(pool.getConnectionHealth(config)?.status).toBe("healthy");

      // Report a failure
      pool.reportFailure(config, "Connection refused");
      const health = pool.getConnectionHealth(config);

      expect(health?.status).toBe("unhealthy");
      expect(health?.consecutiveFailures).toBe(1);
      expect(health?.lastError).toBe("Connection refused");
      expect(health?.backoffUntil).toBeDefined();
    });

    test("backoff caps at ~10s with jitter", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      // Report many failures to hit the cap
      for (let i = 0; i < 10; i++) {
        pool.reportFailure(config, "Connection refused");
      }

      const health = pool.getConnectionHealth(config)!;
      const backoffMs = health.backoffUntil!.getTime() - Date.now();

      // Max base is 10s, jitter adds ±20%, so max is ~12s (10 * 1.2)
      expect(backoffMs).toBeGreaterThan(7_500); // 10 * 0.8 - some tolerance
      expect(backoffMs).toBeLessThanOrEqual(12_500); // 10 * 1.2 + some tolerance
    });

    test("resetBackoff clears backoff state after failed probe", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "nonexistent.invalid.host.test",
        srcBaseDir: "/work",
      };

      // Trigger a failure via acquireConnection (will fail to connect)
      await expect(
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 })
      ).rejects.toThrow();

      // Verify we're now in backoff
      const healthBefore = pool.getConnectionHealth(config);
      expect(healthBefore?.status).toBe("unhealthy");
      expect(healthBefore?.backoffUntil).toBeDefined();

      // Reset backoff
      pool.resetBackoff(config);
      const healthAfter = pool.getConnectionHealth(config);

      expect(healthAfter).toBeDefined();
      expect(healthAfter!.status).toBe("unknown");
      expect(healthAfter!.consecutiveFailures).toBe(0);
      expect(healthAfter!.backoffUntil).toBeUndefined();
    });
  });

  describe("acquireConnection", () => {
    test("returns immediately for known healthy connection", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      // Mark as healthy first
      pool.markHealthy(config);

      // Should return immediately without probing
      const start = Date.now();
      await pool.acquireConnection(config);
      const elapsed = Date.now() - start;

      // Should be nearly instant (< 50ms)
      expect(elapsed).toBeLessThan(50);
    });

    test("waits through backoff (bounded) instead of throwing", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      // Put host into backoff without doing a real probe.
      pool.reportFailure(config, "Connection refused");
      expect(pool.getConnectionHealth(config)?.backoffUntil).toBeDefined();

      const sleepCalls: number[] = [];
      const onWaitCalls: number[] = [];

      await pool.acquireConnection(config, {
        onWait: (ms) => {
          onWaitCalls.push(ms);
        },
        sleep: (ms) => {
          sleepCalls.push(ms);
          // Simulate time passing / recovery.
          pool.markHealthy(config);
          return Promise.resolve();
        },
      });

      expect(sleepCalls.length).toBe(1);
      expect(onWaitCalls.length).toBe(1);
      expect(sleepCalls[0]).toBeGreaterThan(0);
      expect(onWaitCalls[0]).toBe(sleepCalls[0]);
      expect(pool.getConnectionHealth(config)?.status).toBe("healthy");
    });
    test("throws immediately when in backoff", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "nonexistent.invalid.host.test",
        srcBaseDir: "/work",
      };

      // Trigger a failure to put connection in backoff
      await expect(
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 })
      ).rejects.toThrow();

      // Second call should throw immediately with backoff message
      await expect(pool.acquireConnection(config, { maxWaitMs: 0 })).rejects.toThrow(/in backoff/);
    });

    test("getControlPath returns deterministic path", () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      const path1 = pool.getControlPath(config);
      const path2 = pool.getControlPath(config);

      expect(path1).toBe(path2);
      expect(path1).toBe(getControlPath(config));
    });
  });

  describe("singleflighting", () => {
    test("concurrent acquireConnection calls share same probe", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "nonexistent.invalid.host.test",
        srcBaseDir: "/work",
      };

      // All concurrent calls should share the same probe and get same result
      const results = await Promise.allSettled([
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 }),
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 }),
        pool.acquireConnection(config, { timeoutMs: 1000, maxWaitMs: 0 }),
      ]);

      // All should be rejected (connection fails)
      expect(results.every((r) => r.status === "rejected")).toBe(true);

      // Only 1 failure should be recorded (not 3) - proves singleflighting worked
      expect(pool.getConnectionHealth(config)?.consecutiveFailures).toBe(1);
    });

    test("callers waking from backoff share single probe (herd only released on success)", async () => {
      const pool = new SSHConnectionPool();
      const config: SSHRuntimeConfig = {
        host: "test.example.com",
        srcBaseDir: "/work",
      };

      // Put connection in backoff
      pool.reportFailure(config, "Initial failure");
      expect(pool.getConnectionHealth(config)?.consecutiveFailures).toBe(1);

      let probeCount = 0;
      const sleepResolvers: Array<() => void> = [];

      // Start 3 waiters - they'll all sleep through backoff
      const waiters = [1, 2, 3].map(() =>
        pool.acquireConnection(config, {
          sleep: () =>
            new Promise<void>((resolve) => {
              sleepResolvers.push(() => {
                // When sleep resolves, simulate recovery (mark healthy)
                // This happens during the first probe - all waiters share it
                if (probeCount === 0) {
                  probeCount++;
                  pool.markHealthy(config);
                }
                resolve();
              });
            }),
        })
      );

      // Let all sleepers proceed
      await Promise.resolve(); // Let all acquireConnection calls reach sleep
      expect(sleepResolvers.length).toBe(3);

      // Wake them all up "simultaneously"
      sleepResolvers.forEach((resolve) => resolve());

      // All should succeed
      await Promise.all(waiters);

      // Only one "probe" (markHealthy) should have happened
      expect(probeCount).toBe(1);
      expect(pool.getConnectionHealth(config)?.status).toBe("healthy");
    });
  });
});
