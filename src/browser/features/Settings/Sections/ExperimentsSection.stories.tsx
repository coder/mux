import { expect, userEvent, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { DEFAULT_IMAGE_GENERATION_MODEL } from "@/common/types/imageGeneration";
import { DEFAULT_GOAL_DEFAULTS } from "@/constants/goals";
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

export const GoalAndHeartbeatSettingsEnabled: Story = {
  // Goal-defaults editing moved to the in-tab `GoalDefaultsSection` in
  // the workspace sidebar (see `src/browser/features/RightSidebar/`),
  // so the Experiments panel no longer mounts the budget / turn-cap
  // inputs. Heartbeat defaults still render inline here. This story
  // now asserts the new pointer copy + the heartbeat fields.
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: {
            [EXPERIMENT_IDS.GOALS]: true,
            [EXPERIMENT_IDS.WORKSPACE_HEARTBEATS]: true,
          },
          goalDefaults: {
            ...DEFAULT_GOAL_DEFAULTS,
            defaultBudgetCents: 350,
            defaultTurnCap: 8,
          },
          heartbeatDefaultIntervalMs: 45 * 60_000,
          heartbeatDefaultPrompt: "Review pending work before continuing.",
        })
      }
    >
      <ExperimentsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Goal defaults no longer render inline — they live in the Goal tab.
    await expect(canvas.queryByLabelText("Default goal budget in dollars")).toBeNull();
    await expect(canvas.queryByLabelText("Default goal turn cap")).toBeNull();

    // Heartbeat defaults still render inline.
    const heartbeatThresholdInput = await canvas.findByLabelText(
      "Default heartbeat threshold in minutes"
    );
    await waitFor(() => expect(heartbeatThresholdInput).toHaveValue(45));

    const heartbeatPrompt = await canvas.findByLabelText("Default heartbeat prompt");
    await waitFor(() =>
      expect(heartbeatPrompt).toHaveValue("Review pending work before continuing.")
    );
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
