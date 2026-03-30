import type { Meta, StoryObj } from "@storybook/react-vite";
import { within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient, type MockORPCClientOptions } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { selectWorkspace } from "@/browser/stories/helpers/uiState";
import { GovernorSection } from "./GovernorSection.js";
import { SettingsSectionStory } from "./settingsStoryUtils.js";

interface GovernorStoryOptions {
  muxGovernorUrl?: string | null;
  muxGovernorEnrolled?: boolean;
  policyResponse?: MockORPCClientOptions["policyResponse"];
}

function setupGovernorStory(options: GovernorStoryOptions = {}) {
  const workspace = createWorkspace({ id: "ws-governor", name: "main", projectName: "my-app" });
  selectWorkspace(workspace);

  return createMockORPCClient({
    workspaces: [workspace],
    projects: groupWorkspacesByProject([workspace]),
    muxGovernorUrl: options.muxGovernorUrl ?? null,
    muxGovernorEnrolled: options.muxGovernorEnrolled ?? false,
    policyResponse: options.policyResponse ?? {
      source: "none",
      status: { state: "disabled" },
      policy: null,
    },
  });
}

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/GovernorSection",
  component: GovernorSection,
};

export default meta;

type Story = StoryObj<typeof meta>;

function renderGovernorSection(setup: () => ReturnType<typeof createMockORPCClient>) {
  return (
    <SettingsSectionStory setup={setup}>
      <div className="bg-background p-6">
        <GovernorSection />
      </div>
    </SettingsSectionStory>
  );
}

export const NotEnrolled: Story = {
  render: () => renderGovernorSection(() => setupGovernorStory()),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("button", { name: /enroll in mux governor/i });
  },
};

export const EnrolledWithPolicy: Story = {
  render: () =>
    renderGovernorSection(() =>
      setupGovernorStory({
        muxGovernorUrl: "https://governor.example.com",
        muxGovernorEnrolled: true,
        policyResponse: {
          source: "governor",
          status: { state: "enforced" },
          policy: {
            policyFormatVersion: "0.1",
            providerAccess: [{ id: "anthropic", allowedModels: ["claude-sonnet-4-20250514"] }],
            mcp: { allowUserDefined: { stdio: false, remote: true } },
            runtimes: ["local", "worktree", "ssh"],
          },
        },
      })
    ),
};

export const EnrolledPolicyDisabled: Story = {
  render: () =>
    renderGovernorSection(() =>
      setupGovernorStory({
        muxGovernorUrl: "https://governor.example.com",
        muxGovernorEnrolled: true,
        policyResponse: {
          source: "governor",
          status: { state: "disabled" },
          policy: null,
        },
      })
    ),
};

export const EnrolledEnvOverride: Story = {
  render: () =>
    renderGovernorSection(() =>
      setupGovernorStory({
        muxGovernorUrl: "https://governor.example.com",
        muxGovernorEnrolled: true,
        policyResponse: {
          source: "env",
          status: { state: "enforced" },
          policy: {
            policyFormatVersion: "0.1",
            providerAccess: [{ id: "anthropic", allowedModels: null }],
            mcp: { allowUserDefined: { stdio: true, remote: true } },
            runtimes: null,
          },
        },
      })
    ),
};

export const PolicyBlocked: Story = {
  render: () =>
    renderGovernorSection(() =>
      setupGovernorStory({
        muxGovernorUrl: "https://governor.example.com",
        muxGovernorEnrolled: true,
        policyResponse: {
          source: "governor",
          status: { state: "blocked", reason: "blocked by policy" },
          policy: {
            policyFormatVersion: "0.1",
            providerAccess: [],
            mcp: { allowUserDefined: { stdio: false, remote: false } },
            runtimes: ["local"],
          },
        },
      })
    ),
};

export const RichPolicy: Story = {
  render: () =>
    renderGovernorSection(() =>
      setupGovernorStory({
        muxGovernorUrl: "https://governor.example.com",
        muxGovernorEnrolled: true,
        policyResponse: {
          source: "governor",
          status: { state: "enforced" },
          policy: {
            policyFormatVersion: "0.1",
            serverVersion: "2.0.0",
            providerAccess: [
              {
                id: "anthropic",
                allowedModels: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
              },
              {
                id: "openai",
                allowedModels: ["gpt-4o", "gpt-4o-mini"],
                forcedBaseUrl: "https://proxy.corp.example.com/v1",
              },
              { id: "google", allowedModels: null },
            ],
            mcp: { allowUserDefined: { stdio: true, remote: false } },
            runtimes: ["local", "worktree"],
          },
        },
      })
    ),
};
