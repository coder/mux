import { expect, userEvent, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { DEFAULT_IMAGE_GENERATION_MODEL } from "@/common/types/imageGeneration";
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
          experiments: { [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: true },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
};

export const ImageGenerationEnabled: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.IMAGE_GENERATION_TOOL]: true },
          imageGeneration: { modelString: DEFAULT_IMAGE_GENERATION_MODEL, maxImagesPerCall: 4 },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Image Generation Tool")).resolves.toBeInTheDocument();
    await expect(
      canvas.findByDisplayValue(DEFAULT_IMAGE_GENERATION_MODEL)
    ).resolves.toBeInTheDocument();

    const maxImagesInput = await canvas.findByDisplayValue("4");
    await userEvent.clear(maxImagesInput);
    await userEvent.type(maxImagesInput, "11");
    await expect(
      canvas.findByText("Enter a whole number from 1 to 10.")
    ).resolves.toBeInTheDocument();

    await userEvent.clear(maxImagesInput);
    await userEvent.type(maxImagesInput, "2");
    await waitFor(() => expect(maxImagesInput).toHaveValue("2"));
  },
};

export const ExperimentsToggleOff: Story = {
  render: () => (
    <SettingsSectionStory setup={() => setupSettingsStory({})}>
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
};
