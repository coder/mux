import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import React from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getLastRuntimeConfigKey } from "@/common/constants/storage";
import { useDraftWorkspaceSettings } from "./useDraftWorkspaceSettings";

function createStubApiClient(): APIClient {
  // useModelLRU() only needs providers.getConfig + providers.onConfigChanged.
  // Provide a minimal stub so tests can run without spinning up a real oRPC client.
  async function* empty() {
    // no-op
  }

  return {
    providers: {
      getConfig: () => Promise.resolve({}),
      onConfigChanged: () => Promise.resolve(empty()),
    },
  } as unknown as APIClient;
}

describe("useDraftWorkspaceSettings", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("does not reset selected runtime to the default while editing SSH host", async () => {
    const projectPath = "/tmp/project";

    const wrapper: React.FC<{ children: React.ReactNode }> = (props) => (
      <APIProvider client={createStubApiClient()}>
        <ThinkingProvider projectPath={projectPath}>{props.children}</ThinkingProvider>
      </APIProvider>
    );

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    act(() => {
      result.current.setSelectedRuntime({ mode: "ssh", host: "dev@host" });
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({ mode: "ssh", host: "dev@host" });
    });
  });

  test("seeds SSH host from the remembered value when switching modes", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(getLastRuntimeConfigKey(projectPath), {
      ssh: { host: "remembered@host" },
    });

    const wrapper: React.FC<{ children: React.ReactNode }> = (props) => (
      <APIProvider client={createStubApiClient()}>
        <ThinkingProvider projectPath={projectPath}>{props.children}</ThinkingProvider>
      </APIProvider>
    );

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

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
  });

  test("seeds Docker image from the remembered value when switching modes", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(getLastRuntimeConfigKey(projectPath), {
      docker: { image: "ubuntu:22.04", shareCredentials: true },
    });

    const wrapper: React.FC<{ children: React.ReactNode }> = (props) => (
      <APIProvider client={createStubApiClient()}>
        <ThinkingProvider projectPath={projectPath}>{props.children}</ThinkingProvider>
      </APIProvider>
    );

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    act(() => {
      // Simulate UI switching into docker mode with an empty field.
      result.current.setSelectedRuntime({ mode: "docker", image: "" });
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "docker",
        image: "ubuntu:22.04",
        shareCredentials: true,
      });
    });
  });
});
