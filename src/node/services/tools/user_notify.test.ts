/**
 * Tests for user_notify tool - system notification integration
 *
 * The user_notify tool allows AI agents to send system notifications to the user.
 * Notifications appear as OS-native notifications (macOS Notification Center, Windows Toast, etc.)
 *
 * These tests verify the tool's behavior in non-Electron environments (bun test).
 * Full integration testing with actual system notifications requires running in Electron.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createUserNotifyTool } from "./user_notify";
import { createTestToolConfig, TestTempDir } from "./testHelpers";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import type { UserNotifyToolResult } from "@/common/types/tools";

describe("user_notify tool", () => {
  let config: ToolConfiguration;
  let tempDir: TestTempDir;

  beforeEach(() => {
    tempDir = new TestTempDir("user-notify-test");
    config = createTestToolConfig(tempDir.path);
  });

  it("should create a tool with correct schema", () => {
    const tool = createUserNotifyTool(config);
    expect(tool).toBeDefined();
    expect(tool.description).toContain("notification");
  });

  it("should reject empty title", async () => {
    const tool = createUserNotifyTool(config);
    const execute = tool.execute as (args: {
      title: string;
      message?: string;
    }) => Promise<UserNotifyToolResult>;

    const result = await execute({
      title: "",
      message: "Some message",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("title");
    }
  });

  it("should reject whitespace-only title", async () => {
    const tool = createUserNotifyTool(config);
    const execute = tool.execute as (args: {
      title: string;
      message?: string;
    }) => Promise<UserNotifyToolResult>;

    const result = await execute({
      title: "   ",
      message: "Some message",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("title");
    }
  });

  it("should return browser fallback in non-Electron environment", async () => {
    // When running in bun:test (not Electron), tool returns success with browser fallback
    const tool = createUserNotifyTool(config);
    const execute = tool.execute as (args: {
      title: string;
      message?: string;
    }) => Promise<UserNotifyToolResult>;

    const result = await execute({
      title: "Test Notification",
      message: "This is a test",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.notifiedVia).toBe("browser");
      expect(result.title).toBe("Test Notification");
      expect(result.message).toBe("This is a test");
    }
  });

  it("should handle title-only notification (no message)", async () => {
    const tool = createUserNotifyTool(config);
    const execute = tool.execute as (args: {
      title: string;
      message?: string;
    }) => Promise<UserNotifyToolResult>;

    const result = await execute({
      title: "Test Notification",
    });

    // In non-Electron, returns success with browser fallback
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.notifiedVia).toBe("browser");
      expect(result.title).toBe("Test Notification");
      expect(result.message).toBeUndefined();
    }
  });
});
