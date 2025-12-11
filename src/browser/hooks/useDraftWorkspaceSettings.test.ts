import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { useState } from "react";
import {
  getLastDockerImageKey,
  getLastSshHostKey,
  getRuntimeKey,
} from "@/common/constants/storage";
import { useDraftWorkspaceSettings } from "./useDraftWorkspaceSettings";

// A minimal in-memory persisted-state implementation.
// We keep it here (rather than relying on real localStorage) so tests remain deterministic.
const persisted = new Map<string, unknown>();

void mock.module("@/browser/hooks/usePersistedState", () => {
  return {
    usePersistedState: <T>(key: string, defaultValue: T) => {
      const [value, setValue] = useState<T>(() => {
        return persisted.has(key) ? (persisted.get(key) as T) : defaultValue;
      });

      const setAndPersist = (next: T) => {
        persisted.set(key, next);
        setValue(next);
      };

      return [value, setAndPersist] as const;
    },
  };
});

void mock.module("@/browser/hooks/useModelLRU", () => ({
  useModelLRU: () => ({ recentModels: ["test-model"] }),
}));

void mock.module("@/browser/hooks/useThinkingLevel", () => ({
  useThinkingLevel: () => ["medium", () => undefined] as const,
}));

void mock.module("@/browser/contexts/ModeContext", () => ({
  useMode: () => ["plan", () => undefined] as const,
}));

describe("useDraftWorkspaceSettings", () => {
  beforeEach(() => {
    persisted.clear();

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("does not reset selected runtime to the default while editing SSH host", async () => {
    const projectPath = "/tmp/project";

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"));

    act(() => {
      result.current.setSelectedRuntime({ mode: "ssh", host: "dev@host" });
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({ mode: "ssh", host: "dev@host" });
    });
  });

  test("seeds SSH host from the remembered value when switching modes", async () => {
    const projectPath = "/tmp/project";
    persisted.set(getRuntimeKey(projectPath), undefined);
    persisted.set(getLastSshHostKey(projectPath), "remembered@host");

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"));

    act(() => {
      // Simulate UI switching into ssh mode with an empty field.
      result.current.setSelectedRuntime({ mode: "ssh", host: "" });
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "ssh",
        host: "remembered@host",
      });
    });

    expect(persisted.get(getLastSshHostKey(projectPath))).toBe("remembered@host");
  });

  test("seeds Docker image from the remembered value when switching modes", async () => {
    const projectPath = "/tmp/project";
    persisted.set(getRuntimeKey(projectPath), undefined);
    persisted.set(getLastDockerImageKey(projectPath), "ubuntu:22.04");

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"));

    act(() => {
      // Simulate UI switching into docker mode with an empty field.
      result.current.setSelectedRuntime({ mode: "docker", image: "" });
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "docker",
        image: "ubuntu:22.04",
      });
    });

    expect(persisted.get(getLastDockerImageKey(projectPath))).toBe("ubuntu:22.04");
  });
});
