import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { APIClient } from "@/browser/contexts/API";
import { TooltipProvider } from "@/browser/components/ui/tooltip";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { RUNTIME_MODE, type ParsedRuntime } from "@/common/types/runtime";
import type { RuntimeChoice } from "@/browser/utils/runtimeUi";
import type { RemoteMuxServerConfig } from "@/common/types/project";

import { CreationControls } from "./CreationControls";
import type { RuntimeAvailabilityState } from "./useCreationWorkspace";

interface RemoteMuxServerListEntry {
  config: RemoteMuxServerConfig;
  hasAuthToken: boolean;
}

let projects = new Map<string, unknown>();

void mock.module("@/browser/contexts/ProjectContext", () => ({
  useProjectContext: () => ({ projects }),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({
    beginWorkspaceCreation: () => {
      // noop for tests
    },
  }),
}));

let currentApi: { remoteServers: { list: () => Promise<RemoteMuxServerListEntry[]> } } | null =
  null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: (currentApi as unknown as APIClient | null) ?? null,
    status: currentApi ? ("connected" as const) : ("connecting" as const),
    error: null,
  }),
}));

const DEFAULT_NAME_STATE: WorkspaceNameState = {
  name: "test-workspace",
  title: null,
  isGenerating: false,
  autoGenerate: false,
  error: null,
  setAutoGenerate: () => undefined,
  setName: () => undefined,
};

const DEFAULT_RUNTIME_AVAILABILITY: RuntimeAvailabilityState = {
  status: "loaded",
  data: {
    local: { available: true },
    worktree: { available: true },
    ssh: { available: true },
    docker: { available: true },
    devcontainer: { available: true },
  },
};

const DEFAULT_RUNTIME: ParsedRuntime = { mode: RUNTIME_MODE.WORKTREE };

const REMOTE_MUX_SERVERS_EXPERIMENT_KEY = getExperimentKey(EXPERIMENT_IDS.REMOTE_MUX_SERVERS);

function enableRemoteMuxServersExperiment() {
  globalThis.window.localStorage.setItem(REMOTE_MUX_SERVERS_EXPERIMENT_KEY, JSON.stringify(true));
}

function Harness(props: { initialCreateOnRemote: boolean }) {
  const [createOnRemote, setCreateOnRemote] = React.useState(props.initialCreateOnRemote);
  const [remoteServerId, setRemoteServerId] = React.useState<string | null>(null);

  return (
    <TooltipProvider>
      <div>
        <div data-testid="createOnRemote">{createOnRemote ? "remote" : "local"}</div>
        <CreationControls
          branches={["main"]}
          branchesLoaded={true}
          trunkBranch="main"
          onTrunkBranchChange={() => undefined}
          selectedRuntime={DEFAULT_RUNTIME}
          coderConfigFallback={{}}
          sshHostFallback=""
          defaultRuntimeMode={RUNTIME_MODE.WORKTREE as RuntimeChoice}
          onSelectedRuntimeChange={() => undefined}
          onSetDefaultRuntime={() => undefined}
          disabled={false}
          projectPath="/projects/demo"
          projectName="demo"
          nameState={DEFAULT_NAME_STATE}
          runtimeAvailabilityState={DEFAULT_RUNTIME_AVAILABILITY}
          createOnRemote={createOnRemote}
          onCreateOnRemoteChange={setCreateOnRemote}
          remoteServerId={remoteServerId}
          onRemoteServerIdChange={setRemoteServerId}
        />
      </div>
    </TooltipProvider>
  );
}

describe("CreationControls remote server availability", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
    projects = new Map([["/projects/demo", {}]]);
  });

  afterEach(() => {
    cleanup();
    currentApi = null;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("does not render Create-on controls when no remote servers are configured", async () => {
    enableRemoteMuxServersExperiment();

    const listMock = mock(() => Promise.resolve([]));
    currentApi = {
      remoteServers: {
        list: () => listMock(),
      },
    };

    const view = render(<Harness initialCreateOnRemote={true} />);

    await waitFor(() => expect(listMock.mock.calls.length).toBe(1));

    await waitFor(() => {
      expect(view.queryByLabelText("Create on")).toBeNull();
      expect(view.getByTestId("createOnRemote").textContent).toBe("local");
    });
  });

  test("renders Create-on controls when at least one remote server is configured", async () => {
    enableRemoteMuxServersExperiment();

    const listMock = mock(() =>
      Promise.resolve([
        {
          config: {
            id: "remote-1",
            label: "Remote 1",
            baseUrl: "https://example.com",
            enabled: true,
            projectMappings: [],
          },
          hasAuthToken: false,
        },
      ] satisfies RemoteMuxServerListEntry[])
    );

    currentApi = {
      remoteServers: {
        list: () => listMock(),
      },
    };

    const view = render(<Harness initialCreateOnRemote={false} />);

    await waitFor(() => expect(listMock.mock.calls.length).toBe(1));

    await waitFor(() => {
      expect(view.getByLabelText("Create on")).toBeTruthy();
      expect(view.getByTestId("createOnRemote").textContent).toBe("local");
    });
  });

  test("does not render Create-on controls when experiment is disabled (even if remote servers are configured)", async () => {
    const listMock = mock(() =>
      Promise.resolve([
        {
          config: {
            id: "remote-1",
            label: "Remote 1",
            baseUrl: "https://example.com",
            enabled: true,
            projectMappings: [],
          },
          hasAuthToken: false,
        },
      ] satisfies RemoteMuxServerListEntry[])
    );

    currentApi = {
      remoteServers: {
        list: () => listMock(),
      },
    };

    const view = render(<Harness initialCreateOnRemote={true} />);

    await waitFor(() => {
      expect(view.queryByLabelText("Create on")).toBeNull();
      expect(view.getByTestId("createOnRemote").textContent).toBe("local");
    });

    expect(listMock.mock.calls.length).toBe(0);
  });
});
