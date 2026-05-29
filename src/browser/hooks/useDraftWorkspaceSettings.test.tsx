import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";
import React from "react";
import { requireTestModule } from "@/browser/testUtils";
import type * as APIModule from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";
import type * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import type * as ThinkingContextModule from "@/browser/contexts/ThinkingContext";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  DEFAULT_MODEL_KEY,
  DEFAULT_RUNTIME_KEY,
  GLOBAL_SCOPE_ID,
  getAgentIdKey,
  getLastRuntimeConfigKey,
  getModelKey,
  getProjectScopeId,
  getRuntimeKey,
} from "@/common/constants/storage";
import { CODER_RUNTIME_PLACEHOLDER } from "@/common/types/runtime";
import type * as DraftWorkspaceSettingsModule from "./useDraftWorkspaceSettings";

let APIProvider!: typeof APIModule.APIProvider;
let ProjectProvider!: typeof ProjectContextModule.ProjectProvider;
let ThinkingProvider!: typeof ThinkingContextModule.ThinkingProvider;
let useDraftWorkspaceSettings!: typeof DraftWorkspaceSettingsModule.useDraftWorkspaceSettings;
let isolatedModulePaths: string[] = [];

const hooksDir = dirname(fileURLToPath(import.meta.url));
const contextsDir = join(hooksDir, "../contexts");

async function importIsolatedDraftWorkspaceSettingsModules() {
  const suffix = randomUUID();
  const isolatedApiPath = join(contextsDir, `API.real.${suffix}.tsx`);
  const isolatedProjectPath = join(contextsDir, `ProjectContext.real.${suffix}.tsx`);
  const isolatedThinkingPath = join(contextsDir, `ThinkingContext.real.${suffix}.tsx`);
  const isolatedThinkingLevelPath = join(hooksDir, `useThinkingLevel.real.${suffix}.ts`);
  const isolatedHookPath = join(hooksDir, `useDraftWorkspaceSettings.real.${suffix}.ts`);

  await copyFile(join(contextsDir, "API.tsx"), isolatedApiPath);

  const projectContextSource = await readFile(join(contextsDir, "ProjectContext.tsx"), "utf8");
  const isolatedProjectContextSource = projectContextSource.replace(
    'from "@/browser/contexts/API";',
    `from "./API.real.${suffix}.tsx";`
  );

  if (isolatedProjectContextSource === projectContextSource) {
    throw new Error("Failed to rewrite ProjectContext API import for the isolated test copy");
  }

  await writeFile(isolatedProjectPath, isolatedProjectContextSource);

  const thinkingContextSource = await readFile(join(contextsDir, "ThinkingContext.tsx"), "utf8");
  const isolatedThinkingContextSource = thinkingContextSource.replace(
    'from "@/browser/contexts/API";',
    `from "./API.real.${suffix}.tsx";`
  );

  if (isolatedThinkingContextSource === thinkingContextSource) {
    throw new Error("Failed to rewrite ThinkingContext API import for the isolated test copy");
  }

  await writeFile(isolatedThinkingPath, isolatedThinkingContextSource);

  const thinkingLevelSource = await readFile(join(hooksDir, "useThinkingLevel.ts"), "utf8");
  const isolatedThinkingLevelSource = thinkingLevelSource.replace(
    'from "@/browser/contexts/ThinkingContext";',
    `from "../contexts/ThinkingContext.real.${suffix}.tsx";`
  );

  if (isolatedThinkingLevelSource === thinkingLevelSource) {
    throw new Error("Failed to rewrite useThinkingLevel ThinkingContext import");
  }

  await writeFile(isolatedThinkingLevelPath, isolatedThinkingLevelSource);

  const hookSource = await readFile(join(hooksDir, "useDraftWorkspaceSettings.ts"), "utf8");
  const hookWithIsolatedThinkingLevel = hookSource.replace(
    'from "./useThinkingLevel";',
    `from "./useThinkingLevel.real.${suffix}.ts";`
  );

  if (hookWithIsolatedThinkingLevel === hookSource) {
    throw new Error("Failed to rewrite useDraftWorkspaceSettings thinking hook import");
  }

  const isolatedHookSource = hookWithIsolatedThinkingLevel.replace(
    'from "@/browser/contexts/ProjectContext";',
    `from "../contexts/ProjectContext.real.${suffix}.tsx";`
  );

  if (isolatedHookSource === hookWithIsolatedThinkingLevel) {
    throw new Error("Failed to rewrite useDraftWorkspaceSettings project context import");
  }

  await writeFile(isolatedHookPath, isolatedHookSource);

  ({ APIProvider } = requireTestModule<{ APIProvider: typeof APIModule.APIProvider }>(
    isolatedApiPath
  ));
  ({ ProjectProvider } = requireTestModule<{
    ProjectProvider: typeof ProjectContextModule.ProjectProvider;
  }>(isolatedProjectPath));
  ({ ThinkingProvider } = requireTestModule<{
    ThinkingProvider: typeof ThinkingContextModule.ThinkingProvider;
  }>(isolatedThinkingPath));
  ({ useDraftWorkspaceSettings } = requireTestModule<{
    useDraftWorkspaceSettings: typeof DraftWorkspaceSettingsModule.useDraftWorkspaceSettings;
  }>(isolatedHookPath));

  return [
    isolatedApiPath,
    isolatedProjectPath,
    isolatedThinkingPath,
    isolatedThinkingLevelPath,
    isolatedHookPath,
  ];
}

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
    // ProjectProvider calls api.projects.list() on mount.
    projects: {
      list: () => Promise.resolve([]),
    },
  } as unknown as APIClient;
}

function createWrapper(projectPath: string): React.FC<{ children: React.ReactNode }> {
  const Wrapper: React.FC<{ children: React.ReactNode }> = (props) => (
    <APIProvider client={createStubApiClient()}>
      <ProjectProvider>
        <ThinkingProvider projectPath={projectPath}>{props.children}</ThinkingProvider>
      </ProjectProvider>
    </APIProvider>
  );

  Wrapper.displayName = "DraftWorkspaceSettingsTestWrapper";
  return Wrapper;
}

describe("useDraftWorkspaceSettings", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(async () => {
    isolatedModulePaths = await importIsolatedDraftWorkspaceSettingsModules();

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(async () => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;

    for (const modulePath of isolatedModulePaths) {
      await rm(modulePath, { force: true });
    }
    isolatedModulePaths = [];
  });

  test("uses global default agent when project preference is unset", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(getAgentIdKey(GLOBAL_SCOPE_ID), "ask");

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.agentId).toBe("ask");
    });
  });

  test("prefers project agent over global default", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(getAgentIdKey(GLOBAL_SCOPE_ID), "ask");
    updatePersistedState(getAgentIdKey(getProjectScopeId(projectPath)), "plan");

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.agentId).toBe("plan");
    });
  });

  test("preserves explicit gateway model in the project preference", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(getModelKey(getProjectScopeId(projectPath)), "openrouter:openai/gpt-5");

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.model).toBe("openrouter:openai/gpt-5");
    });
  });

  test("preserves explicit gateway model in the global default preference", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(DEFAULT_MODEL_KEY, "openrouter:openai/gpt-5");

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.model).toBe("openrouter:openai/gpt-5");
    });
  });

  test("does not reset selected runtime to the default while editing SSH host", async () => {
    const projectPath = "/tmp/project";

    const wrapper = createWrapper(projectPath);

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

    const wrapper = createWrapper(projectPath);

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

    const wrapper = createWrapper(projectPath);

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

  test("keeps Coder default even after plain SSH usage", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(DEFAULT_RUNTIME_KEY, "coder");
    updatePersistedState(getRuntimeKey(projectPath), "ssh dev@host");
    updatePersistedState(getLastRuntimeConfigKey(projectPath), {
      ssh: {
        host: "dev@host",
        coderEnabled: false,
        coderConfig: { existingWorkspace: false },
      },
    });

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.defaultRuntimeMode).toBe("coder");
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "ssh",
        host: CODER_RUNTIME_PLACEHOLDER,
        coder: { existingWorkspace: false },
      });
    });
  });

  test("persists Coder default string when toggling default", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(getLastRuntimeConfigKey(projectPath), {
      ssh: {
        host: "dev@host",
        coderEnabled: false,
        coderConfig: { existingWorkspace: false },
      },
    });

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    act(() => {
      result.current.setDefaultRuntimeChoice("coder");
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "ssh",
        host: CODER_RUNTIME_PLACEHOLDER,
        coder: { existingWorkspace: false },
      });
    });

    const defaultRuntimeString = readPersistedState<string | undefined>(
      getRuntimeKey(projectPath),
      undefined
    );
    expect(defaultRuntimeString).toBe(`ssh ${CODER_RUNTIME_PLACEHOLDER}`);
  });

  test("exposes persisted Coder config as fallback when re-selecting Coder", async () => {
    const projectPath = "/tmp/project";
    const savedCoderConfig = { existingWorkspace: true, workspaceName: "saved-workspace" };

    updatePersistedState(getLastRuntimeConfigKey(projectPath), {
      ssh: {
        host: "dev@host",
        coderEnabled: false,
        coderConfig: savedCoderConfig,
      },
    });

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.coderConfigFallback).toEqual(savedCoderConfig);
    });
  });

  test("exposes persisted SSH host as fallback when leaving Coder", async () => {
    const projectPath = "/tmp/project";

    updatePersistedState(getLastRuntimeConfigKey(projectPath), {
      ssh: {
        host: "dev@host",
      },
    });

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.sshHostFallback).toBe("dev@host");
    });
  });
});
