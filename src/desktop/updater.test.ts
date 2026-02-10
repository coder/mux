import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "events";
import { UpdaterService, type UpdateStatus } from "./updater";

// Create a mock autoUpdater that's an EventEmitter with the required methods
const mockAutoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  checkForUpdates: mock(() => Promise.resolve()),
  downloadUpdate: mock(() => Promise.resolve()),
  quitAndInstall: mock(() => {
    // Mock implementation - does nothing in tests
  }),
});

// Mock electron-updater module
void mock.module("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

describe("UpdaterService", () => {
  let service: UpdaterService;
  let statusUpdates: UpdateStatus[];
  let originalDebugUpdater: string | undefined;

  beforeEach(() => {
    // Reset mocks
    mockAutoUpdater.checkForUpdates.mockClear();
    mockAutoUpdater.downloadUpdate.mockClear();
    mockAutoUpdater.quitAndInstall.mockClear();
    mockAutoUpdater.removeAllListeners();

    // Save and clear DEBUG_UPDATER to ensure clean test environment
    originalDebugUpdater = process.env.DEBUG_UPDATER;
    delete process.env.DEBUG_UPDATER;
    service = new UpdaterService();

    // Capture status updates via subscriber pattern (ORPC model)
    statusUpdates = [];
    service.subscribe((status) => statusUpdates.push(status));
  });

  afterEach(() => {
    // Restore DEBUG_UPDATER
    if (originalDebugUpdater !== undefined) {
      process.env.DEBUG_UPDATER = originalDebugUpdater;
    } else {
      delete process.env.DEBUG_UPDATER;
    }
  });

  describe("checkForUpdates", () => {
    it("should set status to 'checking' immediately and notify subscribers", () => {
      // Setup
      mockAutoUpdater.checkForUpdates.mockReturnValue(Promise.resolve());

      // Act
      service.checkForUpdates();

      // Assert - should immediately notify with 'checking' status
      expect(statusUpdates).toContainEqual({ type: "checking" });
    });

    it("should transition to 'up-to-date' when no update found", async () => {
      // Setup
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        // Simulate electron-updater behavior: emit event, return unresolved promise
        setImmediate(() => {
          mockAutoUpdater.emit("update-not-available");
        });
        return new Promise(() => {
          // Intentionally never resolves to simulate hanging promise
        });
      });

      // Act
      service.checkForUpdates();

      // Wait for event to be processed
      await new Promise((resolve) => setImmediate(resolve));

      // Assert - should notify with 'up-to-date' status
      expect(statusUpdates).toContainEqual({ type: "checking" });
      expect(statusUpdates).toContainEqual({ type: "up-to-date" });
    });

    it("should transition to 'available' when update found", async () => {
      // Setup
      const updateInfo = {
        version: "1.0.0",
        files: [],
        path: "test-path",
        sha512: "test-sha",
        releaseDate: "2025-01-01",
      };

      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("update-available", updateInfo);
        });
        return new Promise(() => {
          // Intentionally never resolves to simulate hanging promise
        });
      });

      // Act
      service.checkForUpdates();

      // Wait for event to be processed
      await new Promise((resolve) => setImmediate(resolve));

      // Assert
      expect(statusUpdates).toContainEqual({ type: "checking" });
      expect(statusUpdates).toContainEqual({ type: "available", info: updateInfo });
    });

    it("should handle non-transient errors from checkForUpdates", async () => {
      // Use a non-transient error (transient errors like "Network error" now
      // silently back off to idle — see "transient error backoff" tests)
      const error = new Error("Code signing verification failed");

      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        return Promise.reject(error);
      });

      // Act
      service.checkForUpdates();

      // Wait a bit for error to be caught
      await new Promise((resolve) => setImmediate(resolve));

      // Assert
      expect(statusUpdates).toContainEqual({ type: "checking" });

      // Should eventually get error status
      const errorStatus = statusUpdates.find((s) => s.type === "error");
      expect(errorStatus).toBeDefined();
      expect(errorStatus).toEqual({ type: "error", message: "Code signing verification failed" });
    });

    it("should timeout if no events fire within 30 seconds", () => {
      // Use shorter timeout for testing (100ms instead of 30s)
      // We'll verify the timeout logic works, not the exact timing
      const originalSetTimeout = global.setTimeout;
      let timeoutCallback: (() => void) | null = null;

      // Mock setTimeout to capture the timeout callback
      const globalObj = global as { setTimeout: typeof setTimeout };
      globalObj.setTimeout = ((cb: () => void, _delay: number) => {
        timeoutCallback = cb;
        return 123 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      // Setup - checkForUpdates returns promise that never resolves and emits no events
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        return new Promise(() => {
          // Intentionally never resolves to simulate hanging promise
        });
      });

      // Act
      service.checkForUpdates();

      // Should be in checking state
      expect(statusUpdates).toContainEqual({ type: "checking" });

      // Manually trigger the timeout callback
      expect(timeoutCallback).toBeTruthy();
      timeoutCallback!();

      // Should have timed out and returned to idle
      const lastStatus = statusUpdates[statusUpdates.length - 1];
      expect(lastStatus).toEqual({ type: "idle" });

      // Restore original setTimeout
      global.setTimeout = originalSetTimeout;
    });
  });

  describe("transient error backoff", () => {
    it("should silently back off on 404 (latest.yml missing)", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("HttpError: 404 Not Found"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      const lastStatus = statusUpdates[statusUpdates.length - 1];
      expect(lastStatus).toEqual({ type: "idle" });
      expect(statusUpdates.find((s) => s.type === "error")).toBeUndefined();
    });

    it("should silently back off on network errors", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("getaddrinfo ENOTFOUND github.com"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({ type: "idle" });
    });

    it("should silently back off on rate limit errors", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("HttpError: 403 rate limit exceeded"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates[statusUpdates.length - 1]).toEqual({ type: "idle" });
    });

    it("should surface non-transient errors to the user", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("Code signing verification failed"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates.find((s) => s.type === "error")).toEqual({
        type: "error",
        message: "Code signing verification failed",
      });
    });

    it("should surface bare 403 errors (not rate-limit specific)", async () => {
      // A bare 403 without "rate limit" wording may indicate a persistent
      // auth/config issue — should NOT be silently swallowed.
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => {
          mockAutoUpdater.emit("error", new Error("HttpError: 403 Forbidden"));
        });
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      expect(statusUpdates.find((s) => s.type === "error")).toEqual({
        type: "error",
        message: "HttpError: 403 Forbidden",
      });
    });

    it("should surface transient-looking errors during download phase", async () => {
      // A network error during download should NOT be silently dropped to idle.
      // Transient backoff only applies during the "checking" phase.
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => mockAutoUpdater.emit("update-available", { version: "2.0.0" }));
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });
      service.checkForUpdates();
      await new Promise((r) => setImmediate(r));

      // Simulate starting download then hitting a network error
      mockAutoUpdater.emit("download-progress", { percent: 30 });
      mockAutoUpdater.emit("error", new Error("getaddrinfo ENOTFOUND github.com"));

      expect(statusUpdates.find((s) => s.type === "error")).toEqual({
        type: "error",
        message: "getaddrinfo ENOTFOUND github.com",
      });
    });

    it("should silently back off when promise rejects with transient error", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        return Promise.reject(new Error("HttpError: 404 Not Found"));
      });

      service.checkForUpdates();
      await new Promise((resolve) => setImmediate(resolve));

      const lastStatus = statusUpdates[statusUpdates.length - 1];
      expect(lastStatus).toEqual({ type: "idle" });
      expect(statusUpdates.find((s) => s.type === "error")).toBeUndefined();
    });
  });

  describe("state guards", () => {
    it("should skip check when already checking", () => {
      mockAutoUpdater.checkForUpdates.mockReturnValue(
        new Promise(() => {
          // Never resolves
        })
      );
      service.checkForUpdates();
      service.checkForUpdates(); // should be skipped
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("should skip check when downloading", async () => {
      // Get to downloading state via update-available → download-progress
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => mockAutoUpdater.emit("update-available", { version: "2.0.0" }));
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });
      service.checkForUpdates();
      await new Promise((r) => setImmediate(r));
      // Simulate download-progress event to enter downloading state
      mockAutoUpdater.emit("download-progress", { percent: 50 });

      mockAutoUpdater.checkForUpdates.mockClear();
      service.checkForUpdates(); // should be skipped
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(statusUpdates[statusUpdates.length - 1]).toEqual({ type: "downloading", percent: 50 });
    });

    it("should skip check when update already downloaded", async () => {
      mockAutoUpdater.checkForUpdates.mockImplementation(() => {
        setImmediate(() => mockAutoUpdater.emit("update-downloaded", { version: "2.0.0" }));
        return new Promise(() => {
          // Never resolves — events drive state
        });
      });
      service.checkForUpdates();
      await new Promise((r) => setImmediate(r));

      mockAutoUpdater.checkForUpdates.mockClear();
      service.checkForUpdates(); // should be skipped — don't throw away the download
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    it("should return initial status as idle", () => {
      const status = service.getStatus();
      expect(status).toEqual({ type: "idle" });
    });

    it("should return current status after check starts", () => {
      mockAutoUpdater.checkForUpdates.mockReturnValue(Promise.resolve());

      service.checkForUpdates();

      const status = service.getStatus();
      expect(status.type).toBe("checking");
    });
  });
});
