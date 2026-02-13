/**
 * Project Settings stories
 *
 * Shows different states and interactions for project-level configuration:
 * - MCP servers (enable/disable, tool allowlists)
 * - Idle compaction settings
 * - Workspace-level MCP overrides
 *
 * Uses play functions to navigate to settings and interact with the UI.
 */

import React from "react";
import type { MCPServerInfo } from "@/common/types/mcp";
import type { MCPOAuthAuthStatus } from "@/common/types/mcpOauth";
import type { Secret } from "@/common/types/secrets";
import type { APIClient } from "@/browser/contexts/API";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { selectWorkspace } from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { within, userEvent, waitFor, expect } from "@storybook/test";
import { getMCPTestResultsKey } from "@/common/constants/storage";

export default {
  ...appMeta,
  title: "App/Settings/MCP",
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
  /** Global MCP servers (Settings → MCP) */
  servers?: Record<string, MCPServerInfo>;
  /** Optional mock OAuth auth status per MCP server URL (serverUrl -> status) */
  mcpOauthAuthStatus?: Map<string, MCPOAuthAuthStatus>;
  /** Workspace-level MCP overrides */
  workspaceOverrides?: {
    disabledServers?: string[];
    enabledServers?: string[];
    toolAllowlist?: Record<string, string[]>;
  };
  /** Test results for each server (tools available) */
  testResults?: Record<string, string[]>;
  /** Global secrets (used for secret-backed MCP header dropdowns) */
  secrets?: Secret[];
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
    const cacheKeys = [getMCPTestResultsKey("__global__"), getMCPTestResultsKey(projectPath)];
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
    for (const cacheKey of cacheKeys) {
      localStorage.setItem(cacheKey, JSON.stringify(cacheData));
    }
  }

  // Build mock data
  const mcpServers = new Map<string, Record<string, MCPServerInfo>>();
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

  const projectSecrets = new Map<string, Secret[]>();
  if (options.secrets) {
    projectSecrets.set(projectPath, options.secrets);
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
    globalSecrets: options.secrets ?? [],
    projectSecrets,
    globalMcpServers: options.servers ?? {},
    mcpServers,
    mcpOverrides,
    mcpTestResults,
    mcpOauthAuthStatus: options.mcpOauthAuthStatus,
  });
}

/** Open settings modal and navigate to MCP section */
async function openProjectSettings(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);

  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);

  await body.findByRole("dialog", {}, { timeout: 10000 });

  const mcpButton = await body.findByRole("button", { name: /^MCP$/i });
  await userEvent.click(mcpButton);

  const mcpHeading = await body.findByText("MCP Servers");
  mcpHeading.scrollIntoView({ block: "start" });
}

/**
 * Modal roots are ephemeral under Storybook remounts; use query/find split
 * to preserve retry semantics when the dialog briefly disappears.
 */
function queryWorkspaceMCPDialog(canvasElement: HTMLElement): HTMLElement | null {
  const dialog = Array.from(
    canvasElement.ownerDocument.body.querySelectorAll('[role="dialog"]')
  ).find((el) => el.textContent?.includes("Workspace MCP Configuration"));
  return dialog instanceof HTMLElement ? dialog : null;
}

async function findWorkspaceMCPDialog(
  canvasElement: HTMLElement,
  timeout = 10000
): Promise<HTMLElement> {
  return waitFor(
    () => {
      const dialog = queryWorkspaceMCPDialog(canvasElement);
      if (!dialog) {
        throw new Error("Workspace MCP dialog not found");
      }
      return dialog;
    },
    { timeout }
  );
}

function createWorkspaceMCPModalScope(canvasElement: HTMLElement) {
  return {
    query: () => {
      const dialog = queryWorkspaceMCPDialog(canvasElement);
      return dialog ? within(dialog) : null;
    },
    find: async (timeout = 10000) => within(await findWorkspaceMCPDialog(canvasElement, timeout)),
  };
}

/** Open the workspace MCP modal via the "More actions" menu */
async function openWorkspaceMCPModal(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);

  // Wait for workspace header to load
  await canvas.findByTestId("workspace-header", {}, { timeout: 10000 });

  // The popover-to-dialog transition can race in CI when the menu closes before
  // the MCP item click fully commits. Retry the full flow until the modal title
  // appears so the test only proceeds once the real MCP dialog is mounted.
  await waitFor(
    async () => {
      const moreActionsButton = await canvas.findByTestId("workspace-more-actions");
      await userEvent.click(moreActionsButton);

      const mcpButton = await body.findByTestId("workspace-mcp-button", {}, { timeout: 3000 });
      await userEvent.click(mcpButton);

      await findWorkspaceMCPDialog(canvasElement, 3000);
    },
    { timeout: 10000 }
  );
}

const withDesktopWindowApi = [
  (Story: React.FC) => {
    // Save and restore window.api to prevent leaking to other stories
    const originalApiRef = React.useRef(window.api);
    window.api = {
      platform: "darwin",
      versions: {
        node: "20.0.0",
        chrome: "120.0.0",
        electron: "28.0.0",
      },
      isRosetta: false,
    };

    // Cleanup on unmount
    React.useEffect(() => {
      const savedApi = originalApiRef.current;
      return () => {
        window.api = savedApi;
      };
    }, []);

    return <Story />;
  },
];
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

/** Project settings - adding a remote server shows the headers table editor */
export const ProjectSettingsAddRemoteServerHeaders: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          secrets: [
            { key: "MCP_TOKEN", value: "abc123" },
            { key: "MCP_TOKEN_DEV", value: "def456" },
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openProjectSettings(canvasElement);

    const body = within(canvasElement.ownerDocument.body);

    const addServerSummary = await body.findByText(/^Add server$/i);
    await userEvent.click(addServerSummary);

    // Switch the transport to HTTP to reveal the headers editor.
    const transportLabel = await body.findByText("Transport");
    const transportContainer = transportLabel.closest("div");
    await expect(transportContainer).not.toBeNull();

    // Use findByRole (retry-capable) to handle transient DOM gaps between awaits.
    const transportSelect = await within(transportContainer as HTMLElement).findByRole("combobox");
    await userEvent.click(transportSelect);

    const httpOption = await body.findByRole("option", { name: /HTTP \(Streamable\)/i });
    await userEvent.click(httpOption);

    const headersLabel = await body.findByText(/HTTP headers \(optional\)/i);
    headersLabel.scrollIntoView({ block: "center" });

    // Configure a secret-backed Authorization header.
    const addHeaderButton = await body.findByRole("button", { name: /\+ Add header/i });
    await userEvent.click(addHeaderButton);

    // Use findAllByRole / waitFor to handle transient DOM gaps between awaits.
    const headerNameInputs = await body.findAllByPlaceholderText("Authorization");
    await userEvent.type(headerNameInputs[0], "Authorization");

    const secretToggles = await body.findAllByRole("radio", { name: "Secret" });
    await userEvent.click(secretToggles[0]);

    await expect(
      body.findByRole("button", { name: /Choose secret/i })
    ).resolves.toBeInTheDocument();

    const secretValueInput = await body.findByPlaceholderText("MCP_TOKEN");
    await userEvent.type(secretValueInput, "MCP_TOKEN");

    // Add a second plain-text header.
    await userEvent.click(addHeaderButton);

    const headerNameInputsAfterSecond = body.getAllByPlaceholderText("Authorization");
    await userEvent.type(headerNameInputsAfterSecond[1], "X-Env");

    const textValueInput = await body.findByPlaceholderText("value");
    await userEvent.type(textValueInput, "prod");

    await expect(body.findByDisplayValue("Authorization")).resolves.toBeInTheDocument();
    await expect(body.findByDisplayValue("MCP_TOKEN")).resolves.toBeInTheDocument();
    await expect(body.findByDisplayValue("X-Env")).resolves.toBeInTheDocument();
    await expect(body.findByDisplayValue("prod")).resolves.toBeInTheDocument();
  },
};

/** Project settings with MCP servers configured (all enabled) */
export const ProjectSettingsWithServers: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
            filesystem: {
              transport: "stdio",
              command: "npx -y @anthropics/filesystem-server /tmp",
              disabled: false,
            },
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
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: true },
            filesystem: {
              transport: "stdio",
              command: "npx -y @anthropics/filesystem-server /tmp",
              disabled: false,
            },
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
              transport: "stdio",
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

/** Project settings - remote MCP server row with OAuth available (not logged in) */
export const ProjectSettingsOAuthNotLoggedIn: AppStory = {
  decorators: withDesktopWindowApi,
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            "remote-oauth": {
              transport: "http",
              url: "https://example.com/mcp",
              disabled: false,
            },
          },
          mcpOauthAuthStatus: new Map<string, MCPOAuthAuthStatus>([
            [
              "https://example.com/mcp",
              {
                serverUrl: "https://example.com/mcp",
                isLoggedIn: false,
                hasRefreshToken: false,
              },
            ],
          ]),
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openProjectSettings(canvasElement);

    const body = within(canvasElement.ownerDocument.body);
    await body.findByText("remote-oauth");

    // Wait for post-load OAuth status.
    await body.findByText("Not logged in");
    await body.findByRole("button", { name: /^Login$/i });
  },
};

/** Project settings - remote MCP server row with OAuth available (logged in) */
export const ProjectSettingsOAuthLoggedIn: AppStory = {
  decorators: withDesktopWindowApi,
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            "remote-oauth": {
              transport: "http",
              url: "https://example.com/mcp",
              disabled: false,
            },
          },
          mcpOauthAuthStatus: new Map<string, MCPOAuthAuthStatus>([
            [
              "https://example.com/mcp",
              {
                serverUrl: "https://example.com/mcp",
                isLoggedIn: true,
                hasRefreshToken: true,
                updatedAtMs: Date.now() - 60_000,
              },
            ],
          ]),
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openProjectSettings(canvasElement);

    const body = within(canvasElement.ownerDocument.body);
    await body.findByText("remote-oauth");

    // Wait for post-load OAuth status.
    await body.findByText(/Logged in \(1 minute ago\)/i);

    // Actions are grouped under a compact kebab menu.
    const moreActionsButton = await body.findByRole("button", { name: "⋮" });
    await userEvent.click(moreActionsButton);
    await body.findByRole("button", { name: /Re-login/i });
    await body.findByRole("button", { name: /^Logout$/i });
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
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
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
    const modal = createWorkspaceMCPModalScope(canvasElement);

    // Both servers should be shown and enabled.
    await expect((await modal.find()).findByText("mux")).resolves.toBeInTheDocument();
    await expect((await modal.find()).findByText("posthog")).resolves.toBeInTheDocument();
  },
};

/** Workspace MCP modal - server disabled at project level, can be enabled */
export const WorkspaceMCPProjectDisabledServer: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: true },
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
    const modal = createWorkspaceMCPModalScope(canvasElement);

    // posthog should show "(disabled at project level)" but switch should still be toggleable.
    await expect((await modal.find()).findByText("posthog")).resolves.toBeInTheDocument();
    await expect(
      (await modal.find()).findByText(/disabled at project level/i)
    ).resolves.toBeInTheDocument();
  },
};

/** Workspace MCP modal - server disabled at project level, enabled at workspace level */
export const WorkspaceMCPEnabledOverride: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: true },
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
    const modal = createWorkspaceMCPModalScope(canvasElement);

    // posthog should be enabled despite project-level disable.
    await expect((await modal.find()).findByText("posthog")).resolves.toBeInTheDocument();
    await expect(
      (await modal.find()).findByText(/disabled at project level/i)
    ).resolves.toBeInTheDocument();

    // The switch should be ON (enabled at workspace level).
  },
};

/** Workspace MCP modal - server enabled at project level, disabled at workspace level */
export const WorkspaceMCPDisabledOverride: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
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
    const modal = createWorkspaceMCPModalScope(canvasElement);

    // mux should be enabled, posthog should be disabled.
    await expect((await modal.find()).findByText("mux")).resolves.toBeInTheDocument();
    await expect((await modal.find()).findByText("posthog")).resolves.toBeInTheDocument();
  },
};

/** Workspace MCP modal with tool allowlist filtering */
export const WorkspaceMCPWithToolAllowlist: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
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
    const modal = createWorkspaceMCPModalScope(canvasElement);

    await expect((await modal.find()).findByText("posthog")).resolves.toBeInTheDocument();

    // Should show filtered tool count.
    await expect(
      (await modal.find()).findByText(/3 of 14 tools enabled/i)
    ).resolves.toBeInTheDocument();
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
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
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
    const modal = createWorkspaceMCPModalScope(canvasElement);

    // Wait for the modal's data loading to fully settle. After loadData()
    // completes, all tools are allowed by default, so the "All" button is
    // disabled (allAllowed === true). Checking for this avoids interacting
    // with DOM elements that may be stale from an earlier render.
    await waitFor(
      () => {
        const scope = modal.query();
        if (!scope) throw new Error("Workspace MCP dialog missing");

        const allBtn = scope.queryByRole("button", { name: /^All$/i });
        if (!allBtn) throw new Error("All button not found — modal still loading");
        return expect(allBtn).toBeDisabled();
      },
      { timeout: 10000 }
    );

    // Click "None" to deselect all tools.
    // Use findByRole (retry-capable) instead of getByRole to handle transient
    // DOM gaps — in CI the Storybook iframe can briefly unmount/remount the
    // story component between awaits. The longer timeout helps ride out
    // cold-start remounts so the test isn't flaky.
    const noneButton = await (
      await modal.find(10000)
    ).findByRole("button", { name: /^None$/i }, { timeout: 10000 });
    await userEvent.click(noneButton);

    // Re-query for the assertion — the previous noneButton reference could
    // be stale if React replaced the DOM node during re-render.
    await waitFor(() => {
      const scope = modal.query();
      if (!scope) throw new Error("Workspace MCP dialog missing");

      const btn = scope.getByRole("button", { name: /^None$/i });
      return expect(btn).toBeDisabled();
    });

    // Should now show "0 of X tools enabled".
    await (
      await modal.find(10000)
    ).findByText(
      (_content, element) => {
        const text = (element?.textContent ?? "").replace(/\s+/g, " ").trim();
        return /^0 of \d+ tools enabled$/i.test(text);
      },
      {},
      { timeout: 10000 }
    );

    // Click "All" to select all tools.
    // Use findByRole (retry-capable) and re-query inside waitFor to avoid
    // stale refs if the DOM transiently unmounts between awaits. Keep the
    // timeout longer to absorb Storybook remounts in slower CI runs.
    await waitFor(() => {
      const scope = modal.query();
      if (!scope) throw new Error("Workspace MCP dialog missing");

      const btn = scope.getByRole("button", { name: /^All$/i });
      return expect(btn).toBeEnabled();
    });
    const allButton = await (
      await modal.find(10000)
    ).findByRole("button", { name: /^All$/i }, { timeout: 10000 });
    await userEvent.click(allButton);
    await waitFor(() => {
      const scope = modal.query();
      if (!scope) throw new Error("Workspace MCP dialog missing");

      const btn = scope.getByRole("button", { name: /^All$/i });
      return expect(btn).toBeDisabled();
    });
  },
};

/** Toggle server enabled state in workspace modal */
export const ToggleServerEnabled: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupMCPStory({
          servers: {
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
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
    const modal = createWorkspaceMCPModalScope(canvasElement);

    // Find the posthog server row.
    await expect((await modal.find()).findByText("posthog")).resolves.toBeInTheDocument();

    // Find all switches and click the second one (posthog).
    const switches = await (await modal.find()).findAllByRole("switch");
    // posthog should be the second switch
    if (switches.length >= 2) {
      await userEvent.click(switches[1]);
    }
  },
};
