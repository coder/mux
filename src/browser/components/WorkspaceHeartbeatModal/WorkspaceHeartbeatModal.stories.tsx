import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
} from "@/browser/contexts/WorkspaceContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";

import { WorkspaceHeartbeatModal } from "./WorkspaceHeartbeatModal";

const WORKSPACE_ID = "ws-heartbeat-layout";

const LONG_HEARTBEAT_MESSAGE = [
  "Recurring needs-triage reconcile for coder/agent-tty.",
  "Desired state: every open GitHub issue with `needs-triage` and without `triage:ongoing` / `triage:done` has exactly one triage workspace.",
  "Actual-state reads before side effects; archive stale duplicate workspaces; launch missing ones; report the workspace IDs and next blocking decision.",
].join(" ");

type HeartbeatSettings = NonNullable<FrontendWorkspaceMetadata["heartbeat"]>;

function createHeartbeatStoryApi(settings: HeartbeatSettings): APIClient {
  return {
    workspace: {
      heartbeat: {
        get: () => Promise.resolve(settings),
        set: () => Promise.resolve({ success: true, data: undefined }),
      },
    },
    config: {
      getConfig: () =>
        Promise.resolve({
          heartbeatDefaultIntervalMs: HEARTBEAT_DEFAULT_INTERVAL_MS,
          heartbeatDefaultPrompt: "Review current progress and decide whether to continue.",
        }),
    },
  } as unknown as APIClient;
}

function createWorkspaceContextValue(): WorkspaceContextValue {
  return {
    workspaceMetadata: new Map<string, FrontendWorkspaceMetadata>(),
    loading: false,
    loaded: true,
    loadError: null,
    setWorkspaceMetadata: () => undefined,
  } as unknown as WorkspaceContextValue;
}

function WorkspaceHeartbeatModalStoryShell(props: { children: ReactNode }) {
  const settings: HeartbeatSettings = {
    enabled: true,
    intervalMs: 7 * 60_000,
    contextMode: "compact",
    message: LONG_HEARTBEAT_MESSAGE,
  };

  return (
    <APIProvider client={createHeartbeatStoryApi(settings)}>
      <WorkspaceContext.Provider value={createWorkspaceContextValue()}>
        <div className="bg-background min-h-screen">{props.children}</div>
      </WorkspaceContext.Provider>
    </APIProvider>
  );
}

function renderOpenModal() {
  return (
    <WorkspaceHeartbeatModalStoryShell>
      <WorkspaceHeartbeatModal
        workspaceId={WORKSPACE_ID}
        open={true}
        onOpenChange={() => {
          // Keep the modal open for viewport snapshots.
        }}
      />
    </WorkspaceHeartbeatModalStoryShell>
  );
}

async function assertHeartbeatModalLoaded(canvasElement: HTMLElement): Promise<void> {
  const body = within(canvasElement.ownerDocument.body);
  const dialog = await body.findByRole("dialog", { name: "Configure heartbeat" });
  const modal = within(dialog);

  await waitFor(() => {
    const messageField = modal.getByLabelText("Heartbeat message");
    if (!(messageField instanceof HTMLTextAreaElement)) {
      throw new Error("Expected heartbeat message field to be a textarea");
    }
    if (messageField.value !== LONG_HEARTBEAT_MESSAGE) {
      throw new Error("Expected long heartbeat message to load before snapshotting");
    }
  });
}

const meta = {
  title: "Components/WorkspaceHeartbeatModal",
  component: WorkspaceHeartbeatModal,
  args: {
    workspaceId: WORKSPACE_ID,
    open: true,
    onOpenChange: () => undefined,
  },
  parameters: {
    layout: "fullscreen",
    chromatic: { delay: 500 },
  },
} satisfies Meta<typeof WorkspaceHeartbeatModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LongMessageDesktop: Story = {
  globals: {
    viewport: { value: "desktop", isRotated: false },
  },
  parameters: {
    chromatic: {
      modes: {
        "dark-desktop": { theme: "dark", viewport: { width: 1280, height: 800 } },
      },
    },
  },
  render: renderOpenModal,
  play: async ({ canvasElement }) => {
    await assertHeartbeatModalLoaded(canvasElement);
  },
};

export const LongMessageMobile: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    chromatic: {
      modes: {
        "dark-mobile": { theme: "dark", viewport: { width: 375, height: 667 } },
      },
    },
  },
  render: renderOpenModal,
  play: async ({ canvasElement }) => {
    await assertHeartbeatModalLoaded(canvasElement);
  },
};
