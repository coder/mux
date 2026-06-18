import { describe, expect, it } from "bun:test";
import type { MCPServerInfo, WorkspaceMCPOverrides } from "@/common/types/mcp";
import {
  effectiveEnabledServerNames,
  hasAnyOverride,
  isServerEffectivelyEnabled,
  toggleServerOverride,
} from "./workspaceMcpEffective";

const stdio = (disabled: boolean): MCPServerInfo => ({
  transport: "stdio",
  command: "noop",
  disabled,
});

describe("workspaceMcpEffective", () => {
  describe("isServerEffectivelyEnabled", () => {
    it("returns project-level enabled state when no overrides", () => {
      expect(isServerEffectivelyEnabled("a", false, undefined)).toBe(true);
      expect(isServerEffectivelyEnabled("a", true, undefined)).toBe(false);
      expect(isServerEffectivelyEnabled("a", true, {})).toBe(false);
    });

    it("enabledServers wins over project disabled", () => {
      expect(isServerEffectivelyEnabled("a", true, { enabledServers: ["a"] })).toBe(true);
    });

    it("disabledServers wins over project enabled", () => {
      expect(isServerEffectivelyEnabled("a", false, { disabledServers: ["a"] })).toBe(false);
    });

    it("enabledServers takes precedence over disabledServers", () => {
      expect(
        isServerEffectivelyEnabled("a", false, {
          enabledServers: ["a"],
          disabledServers: ["a"],
        })
      ).toBe(true);
    });
  });

  describe("effectiveEnabledServerNames", () => {
    it("returns sorted enabled set from project defaults", () => {
      const servers: Record<string, MCPServerInfo> = {
        b: stdio(false),
        a: stdio(false),
        c: stdio(true),
      };
      expect(effectiveEnabledServerNames(servers, undefined)).toEqual(["a", "b"]);
    });

    it("applies overrides on top of project defaults", () => {
      const servers: Record<string, MCPServerInfo> = {
        a: stdio(false),
        b: stdio(false),
        c: stdio(true),
      };
      const overrides: WorkspaceMCPOverrides = {
        disabledServers: ["a"],
        enabledServers: ["c"],
      };
      expect(effectiveEnabledServerNames(servers, overrides)).toEqual(["b", "c"]);
    });
  });

  describe("toggleServerOverride", () => {
    it("when project-enabled, adds to disabledServers when toggled off", () => {
      const next = toggleServerOverride({}, "a", false, false);
      expect(next.disabledServers).toEqual(["a"]);
      expect(next.enabledServers).toBeUndefined();
    });

    it("when project-enabled, removes from disabledServers when toggled on", () => {
      const next = toggleServerOverride({ disabledServers: ["a"] }, "a", true, false);
      expect(next.disabledServers).toBeUndefined();
      expect(next.enabledServers).toBeUndefined();
    });

    it("when project-disabled, adds to enabledServers when toggled on", () => {
      const next = toggleServerOverride({}, "a", true, true);
      expect(next.enabledServers).toEqual(["a"]);
      expect(next.disabledServers).toBeUndefined();
    });

    it("when project-disabled, removes from enabledServers when toggled off", () => {
      const next = toggleServerOverride({ enabledServers: ["a"] }, "a", false, true);
      expect(next.enabledServers).toBeUndefined();
      expect(next.disabledServers).toBeUndefined();
    });

    it("preserves toolAllowlist when toggling enable state", () => {
      const next = toggleServerOverride({ toolAllowlist: { a: ["x"] } }, "a", false, false);
      expect(next.toolAllowlist).toEqual({ a: ["x"] });
      expect(next.disabledServers).toEqual(["a"]);
    });

    it("does not duplicate entries when toggling repeatedly", () => {
      let s: WorkspaceMCPOverrides = {};
      s = toggleServerOverride(s, "a", false, false);
      s = toggleServerOverride(s, "a", false, false);
      expect(s.disabledServers).toEqual(["a"]);
    });
  });

  describe("hasAnyOverride", () => {
    it("returns false for undefined / empty", () => {
      expect(hasAnyOverride(undefined)).toBe(false);
      expect(hasAnyOverride({})).toBe(false);
      expect(hasAnyOverride({ enabledServers: [], disabledServers: [] })).toBe(false);
    });

    it("returns true when any field has content", () => {
      expect(hasAnyOverride({ enabledServers: ["a"] })).toBe(true);
      expect(hasAnyOverride({ disabledServers: ["a"] })).toBe(true);
      expect(hasAnyOverride({ toolAllowlist: { a: [] } })).toBe(true);
    });
  });
});
