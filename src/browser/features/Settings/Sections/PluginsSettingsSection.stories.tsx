import { useRef } from "react";
import type { FC, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "@storybook/test";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createMockORPCClient, type MockORPCClientOptions } from "@/browser/stories/mocks/orpc";
import type { AgentPluginListItem } from "@/common/orpc/schemas/agentPlugins";

import { PluginsSettingsSection } from "./PluginsSettingsSection";

const MANAGED_ITEM: AgentPluginListItem = {
  name: "grill",
  managed: true,
  present: true,
  location: "~/.mux/plugins/grill",
  version: "1.2.0",
  description: "Relentlessly grills your plans before you commit to them.",
  source: {
    type: "git",
    url: "https://github.com/example/grill.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  installedAt: "2026-08-01T12:00:00.000Z",
  skillCount: 3,
  mcpServerCount: 1,
};

const PINNED_ITEM: AgentPluginListItem = {
  name: "deploy-tools",
  managed: true,
  present: true,
  location: "~/.mux/plugins/deploy-tools",
  version: "2.0.0",
  source: {
    type: "git",
    url: "git@git.corp:infra/deploy-tools.git",
    ref: "v2.0.0",
    refType: "tag",
  },
  lockedSha: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
  installedAt: "2026-07-15T09:30:00.000Z",
  skillCount: 0,
  mcpServerCount: 2,
};

const UNMANAGED_ITEM: AgentPluginListItem = {
  name: "handmade",
  managed: false,
  present: true,
  location: "~/.agents/plugins/handmade",
  description: "Copied into the container by hand; Mux lists it read-only.",
  skillCount: 1,
  mcpServerCount: 0,
};

const MISSING_ITEM: AgentPluginListItem = {
  name: "vanished",
  managed: true,
  present: false,
  location: "~/.mux/plugins/vanished",
  version: "0.4.0",
  source: {
    type: "git",
    url: "https://github.com/example/vanished.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
  installedAt: "2026-06-01T00:00:00.000Z",
  skillCount: 0,
  mcpServerCount: 0,
};

const PluginsSectionStoryShell: FC<{ options: MockORPCClientOptions; children: ReactNode }> = ({
  options,
  children,
}) => {
  const clientRef = useRef<APIClient | null>(null);
  clientRef.current ??= createMockORPCClient(options);

  return (
    <ThemeProvider>
      <TooltipProvider>
        <APIProvider client={clientRef.current}>
          <ExperimentsProvider>{children}</ExperimentsProvider>
        </APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
};

const meta: Meta<typeof PluginsSettingsSection> = {
  title: "Features/Settings/Sections/PluginsSettingsSection",
  component: PluginsSettingsSection,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => (
    <PluginsSectionStoryShell options={{ agentPlugins: { items: [] } }}>
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Installed plugins");
    await canvas.findByText("No plugins installed yet.");
  },
};

export const InstalledWithUpdateStates: Story = {
  render: () => (
    <PluginsSectionStoryShell
      options={{
        agentPlugins: {
          items: [MANAGED_ITEM, PINNED_ITEM, UNMANAGED_ITEM, MISSING_ITEM],
          updateChecks: [
            {
              name: "grill",
              status: "update-available",
              remoteSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
            },
            { name: "deploy-tools", status: "tag-moved" },
            { name: "vanished", status: "error", message: "Could not reach the remote." },
          ],
        },
      }}
    >
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText("grill");
    await canvas.findByText("update available");
    await canvas.findByText("tag moved");
    await canvas.findByText("unmanaged");
    await canvas.findByText("missing");
    // Update action appears only for rows whose tracking ref moved.
    await canvas.findAllByRole("button", { name: /Update/ });
  },
};

export const UninstallConfirmation: Story = {
  render: () => (
    <PluginsSectionStoryShell options={{ agentPlugins: { items: [MANAGED_ITEM] } }}>
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const uninstallButton = await canvas.findByRole("button", { name: /Uninstall grill/ });
    await userEvent.click(uninstallButton);

    // Preserve-by-default: the plugin-data checkbox starts unchecked.
    await canvas.findByText(/Also delete stored plugin data/);
    const checkbox = await canvas.findByRole("checkbox");
    if (checkbox.getAttribute("data-state") !== "unchecked") {
      throw new Error("Plugin-data checkbox must start unchecked (preserve by default)");
    }
  },
};

export const AddPluginConsentPreview: Story = {
  render: () => (
    <PluginsSectionStoryShell
      options={{
        agentPlugins: {
          items: [],
          preview: {
            source: {
              type: "git",
              url: "https://github.com/example/grill.git",
              ref: "main",
              refType: "branch",
            },
            lockedSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            manifest: {
              name: "grill",
              version: "1.2.0",
              description: "Relentlessly grills your plans.",
              authorName: "Example Co",
              license: "MIT",
            },
            skills: [
              { name: "grill", description: "Stress-test a plan before committing to it." },
              { name: "grill-lite", description: "A gentler grilling for small changes." },
            ],
            mcpServers: [
              {
                serverName: "grill-db",
                transport: "stdio",
                summary: "node ~/.mux/plugins/grill/server.js --db ${PLUGIN_DATA}/state.sqlite",
              },
            ],
            warnings: ["Unknown top-level field 'hooks' ignored"],
            targetPath: "~/.mux/plugins/grill",
          },
        },
      }}
    >
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /Add plugin/ }));
    await userEvent.type(await canvas.findByLabelText(/Git URL or owner\/repo/), "example/grill");
    await userEvent.click(await canvas.findByRole("button", { name: /Preview/ }));

    // Consent card: manifest + every skill + every MCP command line before install.
    await canvas.findByText("Skills (2)");
    await canvas.findByText("grill-lite");
    await canvas.findByText("MCP servers (1)");
    await canvas.findByText(/server\.js --db/);
    await canvas.findByText(/Unknown top-level field 'hooks' ignored/);
    await canvas.findByRole("button", { name: /Install/ });
  },
};
