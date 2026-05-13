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
          imageGeneration: {
            modelString: DEFAULT_IMAGE_GENERATION_MODEL,
            maxImagesPerCall: 4,
            allowImageUploadsForEditing: true,
          },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Image Tools")).resolves.toBeInTheDocument();
    await expect(
      canvas.findByDisplayValue(DEFAULT_IMAGE_GENERATION_MODEL)
    ).resolves.toBeInTheDocument();

    const uploadConsentSwitch = await canvas.findByLabelText("Allow image uploads for editing");
    await waitFor(() => expect(uploadConsentSwitch).toHaveAttribute("aria-checked", "true"));
    await userEvent.click(uploadConsentSwitch);
    await waitFor(() => expect(uploadConsentSwitch).toHaveAttribute("aria-checked", "false"));

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
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.IMAGE_GENERATION_TOOL]: false },
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Image Tools")).resolves.toBeInTheDocument();
    const imageToolsToggle = await canvas.findByLabelText("Toggle Image Tools");
    await waitFor(() => expect(imageToolsToggle).toHaveAttribute("aria-checked", "false"));
    await expect(canvas.queryByText("Image model")).toBeNull();
    await expect(canvas.queryByText("Max images per call")).toBeNull();
    await expect(canvas.queryByText("Allow image uploads for editing")).toBeNull();
  },
};
