import { lightweightMeta } from "@/browser/stories/meta.js";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExperimentsSection } from "./ExperimentsSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ExperimentsSection",
  component: ExperimentsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Experiments: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
};

export const ExperimentsToggleOn: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.SYSTEM_1]: true },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
};

export const ExperimentsToggleOff: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
};
