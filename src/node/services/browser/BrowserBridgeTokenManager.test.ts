import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { AssertionError } from "@/common/utils/assert";
import { BrowserBridgeTokenManager } from "./BrowserBridgeTokenManager";

const TOKEN_TTL_MS = 30_000;

describe("BrowserBridgeTokenManager", () => {
  afterEach(() => {
    setSystemTime();
    vi.useRealTimers();
  });

  it("mints a 64-character hex token", () => {
    const manager = new BrowserBridgeTokenManager();

    try {
      const token = manager.mint("workspace-1", "session-a", 9222);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      manager.dispose();
    }
  });

  it("asserts when mint arguments are invalid", () => {
    const manager = new BrowserBridgeTokenManager();

    try {
      expect(() => manager.mint("", "session-a", 9222)).toThrow(AssertionError);
      expect(() => manager.mint("workspace-1", "", 9222)).toThrow(AssertionError);
      expect(() => manager.mint("workspace-1", "session-1", 0)).toThrow(AssertionError);
    } finally {
      manager.dispose();
    }
  });

  it("validates a freshly minted token and returns the bound identifiers", () => {
    const manager = new BrowserBridgeTokenManager();

    try {
      const token = manager.mint("workspace-1", "session-a", 9222);
      expect(manager.validate(token)).toEqual({
        workspaceId: "workspace-1",
        sessionName: "session-a",
        streamPort: 9222,
      });
      expect(manager.validate(token)).toBeNull();
    } finally {
      manager.dispose();
    }
  });

  it("returns null for expired tokens", () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const manager = new BrowserBridgeTokenManager();
    try {
      const token = manager.mint("workspace-1", "session-a", 9222);
      setSystemTime(Date.now() + TOKEN_TTL_MS + 1);
      expect(manager.validate(token)).toBeNull();
    } finally {
      manager.dispose();
    }
  });
});
