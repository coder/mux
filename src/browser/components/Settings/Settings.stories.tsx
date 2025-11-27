import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import React, { useMemo, useState } from "react";
import { SettingsProvider, useSettings } from "@/browser/contexts/SettingsContext";
import { SettingsModal } from "./SettingsModal";
import type { ProvidersConfigMap } from "./types";
import { ORPCProvider, type ORPCClient } from "@/browser/orpc/react";

// Mock providers config for stories
const mockProvidersConfig: ProvidersConfigMap = {
  anthropic: { apiKeySet: true },
  openai: { apiKeySet: true, baseUrl: "https://custom.openai.com" },
  google: { apiKeySet: false },
  xai: { apiKeySet: false },
  ollama: { apiKeySet: false, models: ["llama3.2", "codestral"] },
  openrouter: { apiKeySet: true, models: ["mistral/mistral-7b"] },
};

function createMockProviderClient(config = mockProvidersConfig): ORPCClient {
  return {
    providers: {
      setProviderConfig: () => Promise.resolve({ success: true as const, data: undefined }),
      setModels: () => Promise.resolve({ success: true as const, data: undefined }),
      getConfig: () => Promise.resolve(config),
      list: () => Promise.resolve(Object.keys(config)),
    },
  } as unknown as ORPCClient;
}

// Wrapper component that auto-opens the settings modal
function SettingsStoryWrapper(props: { initialSection?: string; config?: ProvidersConfigMap }) {
  const client = useMemo(() => createMockProviderClient(props.config), [props.config]);
  return (
    <ORPCProvider client={client}>
      <SettingsProvider>
        <SettingsAutoOpen initialSection={props.initialSection} />
        <SettingsModal />
      </SettingsProvider>
    </ORPCProvider>
  );
}

function SettingsAutoOpen(props: { initialSection?: string }) {
  const { open, isOpen } = useSettings();
  const [hasOpened, setHasOpened] = useState(false);

  React.useEffect(() => {
    if (!hasOpened && !isOpen) {
      open(props.initialSection);
      setHasOpened(true);
    }
  }, [hasOpened, isOpen, open, props.initialSection]);

  return null;
}

// Interactive wrapper for testing close behavior
function InteractiveSettingsWrapper(props: { initialSection?: string }) {
  const [reopenCount, setReopenCount] = useState(0);
  const client = useMemo(() => createMockProviderClient(), []);

  return (
    <ORPCProvider client={client}>
      <SettingsProvider key={reopenCount}>
        <div className="p-4">
          <button
            type="button"
            onClick={() => setReopenCount((c) => c + 1)}
            className="bg-accent mb-4 rounded px-4 py-2 text-white"
          >
            Reopen Settings
          </button>
          <div id="close-indicator" className="text-muted text-sm">
            Click overlay or press Escape to close
          </div>
        </div>
        <SettingsAutoOpen initialSection={props.initialSection} />
        <SettingsModal />
      </SettingsProvider>
    </ORPCProvider>
  );
}

const meta = {
  title: "Components/Settings",
  component: SettingsModal,
  parameters: {
    layout: "fullscreen",
  },
  tags: ["autodocs"],
} satisfies Meta<typeof SettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default settings modal showing the General section.
 * Contains theme toggle between light/dark modes.
 */
export const General: Story = {
  render: () => <SettingsStoryWrapper initialSection="general" />,
};

/**
 * Providers section showing API key configuration.
 * - Green dot indicates configured providers
 * - Accordion expands to show API Key and Base URL fields
 * - Shows masked "••••••••" for set keys
 */
export const Providers: Story = {
  render: () => <SettingsStoryWrapper initialSection="providers" />,
};

/**
 * Providers section with expanded Anthropic accordion.
 */
export const ProvidersExpanded: Story = {
  render: () => <SettingsStoryWrapper initialSection="providers" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal to render
    await waitFor(async () => {
      const modal = canvas.getByRole("dialog");
      await expect(modal).toBeInTheDocument();
    });

    // Click Anthropic to expand
    const anthropicButton = canvas.getByRole("button", { name: /Anthropic/i });
    await userEvent.click(anthropicButton);

    // Verify the accordion expanded (API Key label should be visible)
    await waitFor(async () => {
      const apiKeyLabel = canvas.getByText("API Key");
      await expect(apiKeyLabel).toBeVisible();
    });
  },
};

/**
 * Models section showing custom model management.
 * - Form to add new models with provider dropdown
 * - List of existing custom models with delete buttons
 */
export const Models: Story = {
  render: () => <SettingsStoryWrapper initialSection="models" />,
};

/**
 * Models section with no custom models configured.
 */
export const ModelsEmpty: Story = {
  render: () => (
    <SettingsStoryWrapper
      initialSection="models"
      config={{
        anthropic: { apiKeySet: true },
        openai: { apiKeySet: true },
        google: { apiKeySet: false },
        xai: { apiKeySet: false },
        ollama: { apiKeySet: false },
        openrouter: { apiKeySet: false },
      }}
    />
  ),
};

/**
 * Test that clicking overlay closes the modal.
 */
export const OverlayClickCloses: Story = {
  render: () => <InteractiveSettingsWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal
    await waitFor(async () => {
      const modal = canvas.getByRole("dialog");
      await expect(modal).toBeInTheDocument();
    });

    // Wait for event listeners to attach
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Click overlay
    const overlay = document.querySelector('[role="presentation"]');
    await expect(overlay).toBeInTheDocument();
    await userEvent.click(overlay!);

    // Modal should close
    await waitFor(async () => {
      const closedModal = canvas.queryByRole("dialog");
      await expect(closedModal).not.toBeInTheDocument();
    });
  },
};

/**
 * Test that pressing Escape closes the modal.
 */
export const EscapeKeyCloses: Story = {
  render: () => <InteractiveSettingsWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal
    await waitFor(async () => {
      const modal = canvas.getByRole("dialog");
      await expect(modal).toBeInTheDocument();
    });

    // Wait for event listeners
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Press Escape
    await userEvent.keyboard("{Escape}");

    // Modal should close
    await waitFor(async () => {
      const closedModal = canvas.queryByRole("dialog");
      await expect(closedModal).not.toBeInTheDocument();
    });
  },
};

/**
 * Test sidebar navigation between sections.
 */
export const SidebarNavigation: Story = {
  render: () => <SettingsStoryWrapper initialSection="general" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal
    await waitFor(async () => {
      const modal = canvas.getByRole("dialog");
      await expect(modal).toBeInTheDocument();
    });

    // Should start on General - verify by checking theme toggle presence
    await expect(canvas.getByText("Theme")).toBeVisible();

    // Click Providers in sidebar
    const providersNav = canvas.getByRole("button", { name: /Providers/i });
    await userEvent.click(providersNav);

    // Content should update to show Providers section text
    await waitFor(async () => {
      const providersText = canvas.getByText(/Configure API keys/i);
      await expect(providersText).toBeVisible();
    });

    // Click Models in sidebar
    const modelsNav = canvas.getByRole("button", { name: /Models/i });
    await userEvent.click(modelsNav);

    // Content should update to show Models section text
    await waitFor(async () => {
      const modelsText = canvas.getByText(/Add custom models/i);
      await expect(modelsText).toBeVisible();
    });
  },
};

/**
 * Test X button closes the modal.
 */
export const CloseButtonCloses: Story = {
  render: () => <InteractiveSettingsWrapper />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Wait for modal
    await waitFor(async () => {
      const modal = canvas.getByRole("dialog");
      await expect(modal).toBeInTheDocument();
    });

    // Click close button
    const closeButton = canvas.getByRole("button", { name: /Close settings/i });
    await userEvent.click(closeButton);

    // Modal should close
    await waitFor(async () => {
      const closedModal = canvas.queryByRole("dialog");
      await expect(closedModal).not.toBeInTheDocument();
    });
  },
};
