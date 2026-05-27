import { CHROMATIC_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "@storybook/test";
import { ProvidersSection } from "./ProvidersSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

// Chromatic snapshots are disabled here: every story below already drives a
// `play` function that asserts the relevant behavior (empty state, configured
// providers, env-sourced indicators, expanded provider config). The visual
// layout of the providers settings panel has no scroll-fade/animation/state
// nuances worth a pixel baseline, so we free this file's snapshots for use
// elsewhere in the global Chromatic budget (see
// `tests/ui/storybook/budget.test.ts`).
const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ProvidersSection",
  component: ProvidersSection,
  parameters: {
    ...lightweightMeta.parameters,
    chromatic: CHROMATIC_DISABLED,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ProvidersEmpty: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({ providersConfig: {} })}>
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        if (canvas.queryAllByText(/No providers are currently enabled\./i).length === 0) {
          throw new Error("Expected empty providers message to render");
        }
      },
      { timeout: 5000 }
    );
  },
};

export const ProvidersConfigured: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, baseUrl: "" },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "https://custom.openai.com/v1",
            },
            xai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
          },
        })
      }
    >
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findAllByTitle(/^Configured$/i, {}, { timeout: 5000 });
  },
};

export const ProvidersEnvSourced: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            openai: {
              apiKeySet: false,
              apiKeySource: "env",
              isEnabled: true,
              isConfigured: true,
              baseUrlSource: "env",
              baseUrlResolved: "https://env.openai.test/v1",
            },
          },
        })
      }
    >
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  // (meta-level `chromatic: CHROMATIC_DISABLED` already covers this story.)
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const openaiButton = await canvas.findByRole("button", { name: /openai/i });
    await userEvent.click(openaiButton);

    await canvas.findByText("https://env.openai.test/v1");
    await waitFor(() => {
      if (canvas.queryAllByText(/Set by env vars\./i).length < 2) {
        throw new Error("Expected env source labels for OpenAI key and base URL");
      }
    });
  },
};

export const ProvidersExpanded: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, baseUrl: "" },
            openai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
            xai: { apiKeySet: false, isEnabled: true, isConfigured: false, baseUrl: "" },
          },
        })
      }
    >
      <ProvidersSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const openaiButton = await canvas.findByRole("button", { name: /openai/i });
    await userEvent.click(openaiButton);

    await canvas.findByRole("link", { name: /get api key/i });
  },
};
