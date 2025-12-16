/**
 * MCP (Model Context Protocol) configuration stories
 *
 * Shows different states and interactions for MCP server configuration:
 * - Project-level settings (enable/disable servers, tool allowlists)
 * - Workspace-level overrides (enable disabled servers, disable enabled servers)
 * - Tool selection with All/None bulk actions
 *
 * Uses play functions to navigate to settings and interact with the UI.
 */

import type { APIClient } from "@/browser/contexts/API";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace } from "./storyHelpers";
import { createMockORPCClient } from "../../../.storybook/mocks/orpc";
import { within, userEvent, expect } from "@storybook/test";
import { getMCPTestResultsKey } from "@/common/constants/storage";

export default {
  ...appMeta,
  title: "App/MCP",
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_TOOLS = [
  "file_read",
  "file_write",
  "bash",
  "web_search",
  "web_fetch",
  "todo_write",
  "todo_read",
  "status_set",
];

const POSTHOG_TOOLS = [
  "add-insight-to-dashboard",
  "dashboard-create",
  "dashboard-delete",
  "dashboard-get",
  "dashboards-get-all",
  "dashboard-update",
  "docs-search",
  "error-details",
  "list-errors",
  "create-feature-flag",
  "delete-feature-flag",
  "feature-flag-get-all",
  "experiment-get-all",
  "experiment-create",
];

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface MCPStoryOptions {
  /** MCP servers configured at project level */
  servers?: Record<string, { command: string; disabled: boolean; toolAllowlist?: string[] }>;
  /** Workspace-level MCP overrides */
  workspaceOverrides?: {
    disabledServers?: string[];
    enabledServers?: string[];
    toolAllowlist?: Record<string, string[]>;
  };
  /** Test results for each server (tools available) */
  testResults?: Record<string, string[]>;
  /** Pre-cache test results in localStorage */
  preCacheTools?: boolean;
}

function setupMCPStory(options: MCPStoryOptions = {}): APIClient {
  const projectPath = "/Users/test/my-app";
  const workspaceId = "ws-mcp-test";
  const workspaces = [
    createWorkspace({
      id: workspaceId,
      name: "main",
      projectName: "my-app",
      projectPath,
    }),
  ];

  selectWorkspace(workspaces[0]);

  // Pre-cache tool test results if requested
  if (options.preCacheTools && options.testResults) {
    const cacheKey = getMCPTestResultsKey(projectPath);
    const cacheData: Record<
      string,
      { result: { success: true; tools: string[] }; testedAt: number }
    > = {};
    for (const [serverName, tools] of Object.entries(options.testResults)) {
      cacheData[serverName] = {
        result: { success: true, tools },
        testedAt: Date.now(),
      };
    }
    localStorage.setItem(cacheKey, JSON.stringify(cacheData));
  }

  // Build mock data
  const mcpServers = new Map<
    string,
    Record<string, { command: string; disabled: boolean; toolAllowlist?: string[] }>
  >();
  if (options.servers) {
    mcpServers.set(projectPath, options.servers);
  }

  const mcpOverrides = new Map<
    string,
    {
      disabledServers?: string[];
      enabledServers?: string[];
      toolAllowlist?: Record<string, string[]>;
    }
  >();
  if (options.workspaceOverrides) {
    mcpOverrides.set(workspaceId, options.workspaceOverrides);
  }

  const mcpTestResults = new Map<string, { success: true; tools: string[] }>();
  if (options.testResults) {
    for (const [serverName, tools] of Object.entries(options.testResults)) {
      mcpTestResults.set(serverName, { success: true, tools });
    }
  }

  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    mcpServers,
    mcpOverrides,
    mcpTestResults,
  });
}

/** Open settings modal and navigate to Projects section, scrolling to MCP servers */
async function openProjectSettings(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);

  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);

  await body.findByRole("dialog");

  const projectsButton = await body.findByRole("button", { name: /Projects/i });
  await userEvent.click(projectsButton);

  // Scroll to MCP Servers section (past Idle Compaction)
  const mcpHeading = await body.findByText("MCP Servers");
  mcpHeading.scrollIntoView({ block: "start" });
}

/** Open the workspace MCP modal */
async function openWorkspaceMCPModal(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);

  // Wait for workspace header to load
  await canvas.findByTestId("workspace-header", {}, { timeout: 10000 });

  // Click the MCP server button in the header
  const mcpButton = await canvas.findByTestId("workspace-mcp-button");
  await userEvent.click(mcpButton);

  // Wait for dialog
  await body.findByRole("dialog");
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT SETTINGS STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Project settings with no MCP servers configured */
export const ProjectSettingsEmpty: AppStory = {
  render: () => <AppWithMocks setup={() => setupMCPStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openProjectSettings(canvasElement);
  },
};

/** Project settings with MCP servers configured (all enabled) */
export const ProjectSettingsWithServers: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { command: "npx -y posthog-mcp-server", disabled: false },
            filesystem: { command: "npx -y @anthropics/filesystem-server /tmp", disabled: false },
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
            filesystem: ["read_file", "write_file", "list_directory"],
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openProjectSettings(canvasElement);

    // Verify servers are shown
    const body = within(canvasElement.ownerDocument.body);
    await body.findByText("mux");
    await body.findByText("posthog");
    await body.findByText("filesystem");
  },
};

/** Project settings with a mix of enabled and disabled servers */
export const ProjectSettingsMixedState: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { command: "npx -y posthog-mcp-server", disabled: true },
            filesystem: { command: "npx -y @anthropics/filesystem-server /tmp", disabled: false },
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
            filesystem: ["read_file", "write_file", "list_directory"],
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openProjectSettings(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // posthog should show as disabled
    await body.findByText("posthog");
    // The switch should be off for posthog
  },
};

/** Project settings showing tool allowlist (tools filtered) */
export const ProjectSettingsWithToolAllowlist: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: {
              command: "npx -y @anthropics/mux-server",
              disabled: false,
              toolAllowlist: ["file_read", "file_write", "bash"],
            },
          },
          testResults: {
            mux: MOCK_TOOLS,
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openProjectSettings(canvasElement);

    const body = within(canvasElement.ownerDocument.body);
    await body.findByText("mux");

    // Should show "3/8" tools indicator (3 allowed out of 8 total)
    await body.findByText(/3\/8/);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE MCP MODAL STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Workspace MCP modal with servers from project (no overrides) */
export const WorkspaceMCPNoOverrides: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { command: "npx -y posthog-mcp-server", disabled: false },
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openWorkspaceMCPModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // Both servers should be shown and enabled
    await body.findByText("mux");
    await body.findByText("posthog");
  },
};

/** Workspace MCP modal - server disabled at project level, can be enabled */
export const WorkspaceMCPProjectDisabledServer: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { command: "npx -y posthog-mcp-server", disabled: true },
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openWorkspaceMCPModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // posthog should show "(disabled at project level)" but switch should still be toggleable
    await body.findByText("posthog");
    await body.findByText(/disabled at project level/i);
  },
};

/** Workspace MCP modal - server disabled at project level, enabled at workspace level */
export const WorkspaceMCPEnabledOverride: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { command: "npx -y posthog-mcp-server", disabled: true },
          },
          workspaceOverrides: {
            enabledServers: ["posthog"],
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openWorkspaceMCPModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // posthog should be enabled despite project-level disable
    await body.findByText("posthog");
    await body.findByText(/disabled at project level/i);

    // The switch should be ON (enabled at workspace level)
  },
};

/** Workspace MCP modal - server enabled at project level, disabled at workspace level */
export const WorkspaceMCPDisabledOverride: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { command: "npx -y posthog-mcp-server", disabled: false },
          },
          workspaceOverrides: {
            disabledServers: ["posthog"],
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openWorkspaceMCPModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // mux should be enabled, posthog should be disabled
    await body.findByText("mux");
    await body.findByText("posthog");
  },
};

/** Workspace MCP modal with tool allowlist filtering */
export const WorkspaceMCPWithToolAllowlist: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            posthog: { command: "npx -y posthog-mcp-server", disabled: false },
          },
          workspaceOverrides: {
            toolAllowlist: {
              posthog: ["docs-search", "error-details", "list-errors"],
            },
          },
          testResults: {
            posthog: POSTHOG_TOOLS,
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openWorkspaceMCPModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);
    await body.findByText("posthog");

    // Should show filtered tool count
    await body.findByText(/3 of 14 tools enabled/i);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTION STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Interact with tool selector - click All/None buttons */
export const ToolSelectorInteraction: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { command: "npx -y @anthropics/mux-server", disabled: false },
          },
          testResults: {
            mux: MOCK_TOOLS,
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openWorkspaceMCPModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // Find the tool selector section
    await body.findByText("mux");

    // Click "None" to deselect all tools
    const noneButton = await body.findByRole("button", { name: /^None$/i });
    await userEvent.click(noneButton);

    // Should now show "0 of X tools enabled"
    await expect(body.findByText(/0 of \d+ tools enabled/i)).resolves.toBeInTheDocument();

    // Click "All" to select all tools
    const allButton = await body.findByRole("button", { name: /^All$/i });
    await userEvent.click(allButton);
  },
};

/** Toggle server enabled state in workspace modal */
export const ToggleServerEnabled: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { command: "npx -y posthog-mcp-server", disabled: false },
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
          },
          preCacheTools: true,
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openWorkspaceMCPModal(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    // Find the posthog server row
    await body.findByText("posthog");

    // Find all switches and click the second one (posthog)
    const switches = await body.findAllByRole("switch");
    // posthog should be the second switch
    if (switches.length >= 2) {
      await userEvent.click(switches[1]);
    }
  },
};
