import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "@storybook/test";
import { ProvidersSection } from "./ProvidersSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ProvidersSection",
  component: ProvidersSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ProvidersEmpty: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({ providersConfig: {} })}>
      <ProvidersSection />
    </SettingsSectionStory>
  ),
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
