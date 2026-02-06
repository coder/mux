/**
 * Governor section stories
 *
 * Shows different states of the Governor (enterprise policy) section:
 * - Not enrolled (default)
 * - Enrolled with active policy
 * - Enrolled with policy disabled
 * - Enrolled with env override
 * - Policy blocked (fully restricted)
 * - Rich policy (many providers with varied restrictions)
 *
 * Uses play functions to open the settings modal and navigate to the Governor section.
 */

import type { APIClient } from "@/browser/contexts/API";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace, expandProjects, collapseRightSidebar } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { within, userEvent, waitFor } from "@storybook/test";
import type { PolicyGetResponse, PolicySource, EffectivePolicy } from "@/common/orpc/types";
import { getExperimentKey, EXPERIMENT_IDS } from "@/common/constants/experiments";

export default {
  ...appMeta,
  title: "App/Settings/Governor",
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface GovernorStoryOptions {
  muxGovernorUrl?: string | null;
  muxGovernorEnrolled?: boolean;
  policySource?: PolicySource;
  policyState?: "disabled" | "enforced" | "blocked";
  policy?: EffectivePolicy | null;
}

/** Setup workspaces across multiple projects for a lived-in sidebar */
function setupGovernorStory(options: GovernorStoryOptions = {}): APIClient {
  const workspaces = [
    createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" }),
    createWorkspace({ id: "ws-2", name: "feat/auth", projectName: "my-app" }),
    createWorkspace({ id: "ws-3", name: "hotfix/login", projectName: "my-app" }),
    createWorkspace({ id: "ws-4", name: "main", projectName: "infra-tools" }),
    createWorkspace({ id: "ws-5", name: "migrate-db", projectName: "infra-tools" }),
  ];

  selectWorkspace(workspaces[0]);

  // Expand both projects so sidebar looks populated behind the modal
  const projectPaths = [...new Set(workspaces.map((w) => w.projectPath))];
  expandProjects(projectPaths);
  collapseRightSidebar();

  // Enable the Governor experiment so the section appears in Settings
  const experimentKey = getExperimentKey(EXPERIMENT_IDS.MUX_GOVERNOR);
  window.localStorage.setItem(experimentKey, JSON.stringify(true));

  const {
    muxGovernorUrl = null,
    muxGovernorEnrolled = false,
    policySource = "none",
    policyState = "disabled",
    policy = null,
  } = options;

  const policyResponse: PolicyGetResponse = {
    source: policySource,
    status: { state: policyState },
    policy,
  };

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    muxGovernorUrl,
    muxGovernorEnrolled,
    policyResponse,
  });
}

/** Open settings page and navigate to Governor section. */
async function openSettingsToGovernor(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);

  // Wait for app to fully load.
  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);

  // Navigate to Governor section (desktop + mobile nav are both in DOM during tests).
  const governorButtons = await canvas.findAllByRole("button", { name: /governor/i });
  const governorButton = governorButtons[0];
  if (!governorButton) {
    throw new Error("Governor settings button not found");
  }
  await userEvent.click(governorButton);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Governor section - not enrolled (default state) */
export const NotEnrolled: AppStory = {
  render: () => <AppWithMocks setup={() => setupGovernorStory()} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToGovernor(canvasElement);
  },
};

/** Governor section - enrolled with active policy from Governor */
export const EnrolledWithPolicy: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupGovernorStory({
          muxGovernorUrl: "https://governor.example.com",
          muxGovernorEnrolled: true,
          policySource: "governor",
          policyState: "enforced",
          policy: {
            policyFormatVersion: "0.1",
            serverVersion: "1.0.0",
            providerAccess: [
              { id: "anthropic", allowedModels: ["claude-sonnet-4-20250514"] },
              {
                id: "openai",
                forcedBaseUrl: "https://api.internal.example.com/v1",
                allowedModels: null,
              },
            ],
            mcp: { allowUserDefined: { stdio: false, remote: true } },
            runtimes: ["local", "worktree", "ssh"],
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToGovernor(canvasElement);
  },
};

/** Governor section - enrolled but policy disabled (no policy enforced) */
export const EnrolledPolicyDisabled: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupGovernorStory({
          muxGovernorUrl: "https://governor.example.com",
          muxGovernorEnrolled: true,
          policySource: "governor",
          policyState: "disabled",
          policy: null,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToGovernor(canvasElement);
  },
};

/** Governor section - enrolled with policy from environment variable (takes precedence) */
export const EnrolledEnvOverride: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupGovernorStory({
          muxGovernorUrl: "https://governor.example.com",
          muxGovernorEnrolled: true,
          policySource: "env",
          policyState: "enforced",
          policy: {
            policyFormatVersion: "0.1",
            providerAccess: [{ id: "anthropic", allowedModels: null }],
            mcp: { allowUserDefined: { stdio: true, remote: true } },
            runtimes: null,
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToGovernor(canvasElement);
  },
};

/** Governor section - enrolled with policy blocking all operations (no providers, no MCP) */
export const PolicyBlocked: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupGovernorStory({
          muxGovernorUrl: "https://governor.example.com",
          muxGovernorEnrolled: true,
          policySource: "governor",
          policyState: "blocked",
          policy: {
            policyFormatVersion: "0.1",
            serverVersion: "1.2.0",
            providerAccess: [], // no providers allowed
            mcp: { allowUserDefined: { stdio: false, remote: false } },
            runtimes: ["local"], // only local allowed
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    // PolicyBlockedScreen shows a message about policy blocking
    await waitFor(
      () => {
        body.getByText(/blocked by policy/i);
      },
      { timeout: 10_000 }
    );
  },
};

/** Governor section - enrolled with a comprehensive policy showing many providers with varied restrictions */
export const RichPolicy: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupGovernorStory({
          muxGovernorUrl: "https://governor.example.com",
          muxGovernorEnrolled: true,
          policySource: "governor",
          policyState: "enforced",
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
              { id: "google", allowedModels: null }, // all models allowed
            ],
            mcp: { allowUserDefined: { stdio: true, remote: false } },
            runtimes: ["local", "worktree"],
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettingsToGovernor(canvasElement);
  },
};
