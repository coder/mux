import { describe, it, expect } from "bun:test";
import {
  resolveDevcontainerSelection,
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
} from "./devcontainerSelection";
import type { RuntimeAvailabilityState } from "@/browser/components/ChatInput/useCreationWorkspace";

describe("resolveDevcontainerSelection", () => {
  describe("non-devcontainer mode", () => {
    it("returns hidden when mode is worktree", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "worktree" },
        availabilityState: { status: "loading" },
      });

      expect(result.uiMode).toBe("hidden");
      expect(result.isCreatable).toBe(true);
      expect(result.configPath).toBe("");
    });

    it("returns hidden when mode is local", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "local" },
        availabilityState: { status: "loaded", data: {} as unknown as never },
      });

      expect(result.uiMode).toBe("hidden");
      expect(result.isCreatable).toBe(true);
    });
  });

  describe("loading state", () => {
    const loadingState: RuntimeAvailabilityState = { status: "loading" };

    it("returns input mode with no implicit default (P2 fix)", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: "" },
        availabilityState: loadingState,
      });

      expect(result.uiMode).toBe("input");
      expect(result.configPath).toBe("");
      expect(result.isCreatable).toBe(false);
      expect(result.helperText).toBe("Loading configs…");
    });

    it("is creatable when user provides explicit path", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: ".devcontainer.json" },
        availabilityState: loadingState,
      });

      expect(result.uiMode).toBe("input");
      expect(result.configPath).toBe(".devcontainer.json");
      expect(result.isCreatable).toBe(true);
    });
  });

  describe("failed state", () => {
    const failedState: RuntimeAvailabilityState = { status: "failed" };

    it("defaults to standard path when no selection", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: "" },
        availabilityState: failedState,
      });

      expect(result.uiMode).toBe("input");
      expect(result.configPath).toBe(DEFAULT_DEVCONTAINER_CONFIG_PATH);
      expect(result.isCreatable).toBe(true);
      expect(result.helperText).toBe("Configs couldn't be loaded. Enter a path to continue.");
    });

    it("preserves explicit user selection", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: ".devcontainer.json" },
        availabilityState: failedState,
      });

      expect(result.configPath).toBe(".devcontainer.json");
      expect(result.isCreatable).toBe(true);
    });
  });

  describe("loaded state with configs", () => {
    const loadedWithConfigs: RuntimeAvailabilityState = {
      status: "loaded",
      data: {
        worktree: { available: true },
        local: { available: true },
        ssh: { available: true },
        docker: { available: true },
        devcontainer: {
          available: true,
          configs: [
            { path: ".devcontainer/devcontainer.json", label: "Default" },
            { path: ".devcontainer/python/devcontainer.json", label: "Python" },
          ],
        },
      },
    };

    it("returns dropdown mode with configs", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: "" },
        availabilityState: loadedWithConfigs,
      });

      expect(result.uiMode).toBe("dropdown");
      expect(result.configs).toHaveLength(2);
      expect(result.configPath).toBe(".devcontainer/devcontainer.json");
      expect(result.isCreatable).toBe(true);
      expect(result.helperText).toBeNull();
    });

    it("preserves valid selected path", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: {
          mode: "devcontainer",
          configPath: ".devcontainer/python/devcontainer.json",
        },
        availabilityState: loadedWithConfigs,
      });

      expect(result.configPath).toBe(".devcontainer/python/devcontainer.json");
    });

    it("falls back to first config when selection is invalid", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: "nonexistent.json" },
        availabilityState: loadedWithConfigs,
      });

      expect(result.configPath).toBe(".devcontainer/devcontainer.json");
    });
  });

  describe("loaded state with no configs", () => {
    const loadedNoConfigs: RuntimeAvailabilityState = {
      status: "loaded",
      data: {
        worktree: { available: true },
        local: { available: true },
        ssh: { available: true },
        docker: { available: true },
        devcontainer: { available: true, configs: [] },
      },
    };

    it("returns hidden mode when no configs found (blocks creation)", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: "" },
        availabilityState: loadedNoConfigs,
      });

      expect(result.uiMode).toBe("hidden");
      expect(result.configPath).toBe("");
      expect(result.isCreatable).toBe(false);
      expect(result.helperText).toBeNull();
    });

    it("blocks creation even if user somehow provides path", () => {
      const result = resolveDevcontainerSelection({
        selectedRuntime: { mode: "devcontainer", configPath: ".devcontainer.json" },
        availabilityState: loadedNoConfigs,
      });

      // UI hides devcontainer when no configs - this is a safeguard
      expect(result.isCreatable).toBe(false);
      expect(result.configPath).toBe("");
    });
  });
});
