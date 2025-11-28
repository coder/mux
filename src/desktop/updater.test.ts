/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/unbound-method */

import { UpdaterService } from "./updater";
import { autoUpdater } from "electron-updater";
import type { BrowserWindow } from "electron";

// Mock electron-updater
jest.mock("electron-updater", () => {
  const EventEmitter = require("events");
  const mockAutoUpdater = new EventEmitter();
  return {
    autoUpdater: Object.assign(mockAutoUpdater, {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      checkForUpdates: jest.fn(),
      downloadUpdate: jest.fn(),
      quitAndInstall: jest.fn(),
    }),
  };
});

describe("UpdaterService", () => {
  let service: UpdaterService;
  let mockWindow: jest.Mocked<BrowserWindow>;
  let originalDebugUpdater: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    // Save and clear DEBUG_UPDATER to ensure clean test environment
    originalDebugUpdater = process.env.DEBUG_UPDATER;
    delete process.env.DEBUG_UPDATER;
    service = new UpdaterService();

    // Create mock window
    mockWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: {
        send: jest.fn(),
      },
    } as any;

    service.setMainWindow(mockWindow);
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
    it("should set status to 'checking' immediately and notify renderer", () => {
      // Setup
      const checkForUpdatesMock = autoUpdater.checkForUpdates as jest.Mock;
      checkForUpdatesMock.mockReturnValue(Promise.resolve());

      // Act
      service.checkForUpdates();

      // Assert - should immediately notify with 'checking' status
      expect(mockWindow.webContents.send).toHaveBeenCalledWith("update:status", {
        type: "checking",
      });
    });

    it("should transition to 'up-to-date' when no update found", async () => {
      // Setup
      const checkForUpdatesMock = autoUpdater.checkForUpdates as jest.Mock;
      checkForUpdatesMock.mockImplementation(() => {
        // Simulate electron-updater behavior: emit event, return unresolved promise
        setImmediate(() => {
          (autoUpdater as any).emit("update-not-available");
        });
        return new Promise(() => {}); // Never resolves
      });

      // Act
      service.checkForUpdates();

      // Wait for event to be processed
      await new Promise((resolve) => setImmediate(resolve));

      // Assert - should notify with 'up-to-date' status
      const calls = (mockWindow.webContents.send as jest.Mock).mock.calls;
      expect(calls).toContainEqual(["update:status", { type: "checking" }]);
      expect(calls).toContainEqual(["update:status", { type: "up-to-date" }]);
    });

    it("should transition to 'available' when update found", async () => {
      // Setup
      const checkForUpdatesMock = autoUpdater.checkForUpdates as jest.Mock;
      const updateInfo = {
        version: "1.0.0",
        files: [],
        path: "test-path",
        sha512: "test-sha",
        releaseDate: "2025-01-01",
      };

      checkForUpdatesMock.mockImplementation(() => {
        setImmediate(() => {
          (autoUpdater as any).emit("update-available", updateInfo);
        });
        return new Promise(() => {}); // Never resolves
      });

      // Act
      service.checkForUpdates();

      // Wait for event to be processed
      await new Promise((resolve) => setImmediate(resolve));

      // Assert
      const calls = (mockWindow.webContents.send as jest.Mock).mock.calls;
      expect(calls).toContainEqual(["update:status", { type: "checking" }]);
      expect(calls).toContainEqual(["update:status", { type: "available", info: updateInfo }]);
    });

    it("should handle errors from checkForUpdates", async () => {
      // Setup
      const checkForUpdatesMock = autoUpdater.checkForUpdates as jest.Mock;
      const error = new Error("Network error");

      checkForUpdatesMock.mockImplementation(() => {
        return Promise.reject(error);
      });

      // Act
      service.checkForUpdates();

      // Wait a bit for error to be caught
      await new Promise((resolve) => setImmediate(resolve));

      // Assert
      const calls = (mockWindow.webContents.send as jest.Mock).mock.calls;
      expect(calls).toContainEqual(["update:status", { type: "checking" }]);

      // Should eventually get error status
      const errorCall = calls.find((call) => call[1].type === "error");
      expect(errorCall).toBeDefined();
      expect(errorCall[1]).toEqual({
        type: "error",
        message: "Network error",
      });
    });

    it("should timeout if no events fire within 30 seconds", () => {
      // Use shorter timeout for testing (100ms instead of 30s)
      // We'll verify the timeout logic works, not the exact timing
      const originalSetTimeout = global.setTimeout;
      let timeoutCallback: (() => void) | null = null;

      // Mock setTimeout to capture the timeout callback
      (global as any).setTimeout = ((cb: () => void, _delay: number) => {
        timeoutCallback = cb;
        return 123 as any; // Return fake timer ID
      }) as any;

      // Setup - checkForUpdates returns promise that never resolves and emits no events
      const checkForUpdatesMock = autoUpdater.checkForUpdates as jest.Mock;
      checkForUpdatesMock.mockImplementation(() => {
        return new Promise(() => {}); // Hangs forever, no events
      });

      // Act
      service.checkForUpdates();

      // Should be in checking state
      expect(mockWindow.webContents.send).toHaveBeenCalledWith("update:status", {
        type: "checking",
      });

      // Manually trigger the timeout callback
      expect(timeoutCallback).toBeTruthy();
      timeoutCallback!();

      // Should have timed out and returned to idle
      const calls = (mockWindow.webContents.send as jest.Mock).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toEqual(["update:status", { type: "idle" }]);

      // Restore original setTimeout
      global.setTimeout = originalSetTimeout;
    });
  });

  describe("getStatus", () => {
    it("should return initial status as idle", () => {
      const status = service.getStatus();
      expect(status).toEqual({ type: "idle" });
    });

    it("should return current status after check starts", () => {
      const checkForUpdatesMock = autoUpdater.checkForUpdates as jest.Mock;
      checkForUpdatesMock.mockReturnValue(Promise.resolve());

      service.checkForUpdates();

      const status = service.getStatus();
      expect(status.type).toBe("checking");
    });
  });
});
