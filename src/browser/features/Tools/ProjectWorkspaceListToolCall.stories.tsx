import type { Meta, StoryObj } from "@storybook/react-vite";

import { ProjectWorkspaceListToolCall } from "@/browser/features/Tools/ProjectWorkspaceListToolCall";
import { PIXEL_DISABLED, lightweightMeta, StoryUiShell } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/ProjectWorkspaceList",
  component: ProjectWorkspaceListToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    // Interaction-only: full Project Chat stories own the responsive Pixel matrix.
    pixel: PIXEL_DISABLED,
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-background p-6">
          <div className="w-full max-w-2xl">
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof ProjectWorkspaceListToolCall>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MixedLifecycle: Story = {
  args: {
    args: { include_archived: true },
    status: "completed",
    defaultExpanded: true,
    result: {
      projectPath: "/Users/dev/customer-platform",
      availableProjects: [
        {
          projectPath: "/Users/dev/customer-platform",
          displayName: "Customer Platform",
          kind: "parent",
        },
        {
          projectPath: "/Users/dev/customer-platform/packages/customer-facing-web-application",
          displayName: "Customer-facing web application with a very long project label",
          kind: "sub_project",
        },
      ],
      workspaces: [
        {
          workspaceId: "24e33167af",
          name: "orchestrator-ui",
          projectPath: "/Users/dev/customer-platform",
          projectDisplayName: "Customer Platform",
          subProjectPath: null,
          title: "Build project orchestration UI",
          archived: false,
          workspaceTurn: {
            taskId: "wst_24e33167af",
            status: "running",
            updatedAt: "2026-08-06T03:00:00.000Z",
          },
        },
        {
          workspaceId: "4a92f76fbf",
          name: "backend-contract",
          projectPath: "/Users/dev/customer-platform/packages/customer-facing-web-application",
          projectDisplayName: "Customer-facing web application with a very long project label",
          subProjectPath: "/Users/dev/customer-platform/packages/customer-facing-web-application",
          title: "Implement Project Chat backend",
          archived: false,
          workspaceTurn: {
            taskId: "wst_4a92f76fbf",
            status: "completed",
            updatedAt: "2026-08-06T02:30:00.000Z",
          },
        },
        {
          workspaceId: "0b71c40e21",
          name: "old-spike",
          projectPath: "/Users/dev/customer-platform",
          projectDisplayName: "Customer Platform",
          subProjectPath: null,
          archived: true,
          transcriptOnly: true,
        },
      ],
    },
  },
};
