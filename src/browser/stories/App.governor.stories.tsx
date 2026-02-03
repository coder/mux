/**
 * Governor section stories
 *
 * Shows different states of the Governor (enterprise policy) section:
 * - Not enrolled (default)
 * - Enrolled with active policy
 * - Enrolled with policy disabled
 *
 * Uses play functions to open the settings modal and navigate to the Governor section.
 */

import type { APIClient } from "@/browser/contexts/API";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { within, userEvent } from "@storybook/test";
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

/** Setup basic workspace for Governor stories */
function setupGovernorStory(options: GovernorStoryOptions = {}): APIClient {
  const workspaces = [createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" })];

  selectWorkspace(workspaces[0]);

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

/** Open settings modal and navigate to Governor section */
async function openSettingsToGovernor(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);

  // Wait for app to fully load
  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);

  // Wait for dialog to appear
  await body.findByRole("dialog");

  // Navigate to Governor section
  const governorButton = await body.findByRole("button", { name: /governor/i });
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
