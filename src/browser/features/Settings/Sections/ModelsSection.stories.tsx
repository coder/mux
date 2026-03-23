/**
 * NOTE: ModelsSection contains an in-app CTA ("Go to Agent defaults") that calls
 * openSettings("tasks"). In isolated section stories the CTA navigates to the
 * agents section via settings context, but the visual section swap is only
 * exercised in the SettingsPage smoke story.
 */
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelsSection } from "./ModelsSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ModelsSection",
  component: ModelsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ModelsEmpty: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: [],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: [],
            },
          },
        })
      }
    >
      <ModelsSection />
    </SettingsSectionStory>
  ),
};

export const ModelsConfigured: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() => {
        window.localStorage.setItem(
          "provider_options_anthropic",
          JSON.stringify({ use1MContextModels: ["anthropic:claude-sonnet-4-20250514"] })
        );

        return setupSettingsStory({
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-6"],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            },
            xai: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: false,
              baseUrl: "",
              models: ["grok-beta"],
            },
          },
        });
      }}
    >
      <ModelsSection />
    </SettingsSectionStory>
  ),
};
