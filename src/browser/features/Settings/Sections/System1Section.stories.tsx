import { lightweightMeta } from "@/browser/stories/meta.js";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";
import { System1Section } from "./System1Section.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/System1Section",
  component: System1Section,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const System1: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          experiments: { [EXPERIMENT_IDS.SYSTEM_1]: true },
          taskSettings: {
            bashOutputCompactionMinLines: 12,
            bashOutputCompactionMinTotalBytes: 8192,
            bashOutputCompactionMaxKeptLines: 55,
            bashOutputCompactionTimeoutMs: 9000,
          },
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            },
          },
        })
      }
    >
      <System1Section />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText(/System 1 Model/i);
    await canvas.findByText(/System 1 Reasoning/i);
    await canvas.findByRole("heading", { name: /bash output compaction/i });

    await waitFor(() => {
      const inputs = canvas.queryAllByRole("spinbutton");
      if (inputs.length !== 4) {
        throw new Error(`Expected 4 System 1 inputs, got ${inputs.length}`);
      }
      const minLines = (inputs[0] as HTMLInputElement).value;
      const minTotalKb = (inputs[1] as HTMLInputElement).value;
      const maxKeptLines = (inputs[2] as HTMLInputElement).value;
      const timeoutSeconds = (inputs[3] as HTMLInputElement).value;

      if (minLines !== "12") {
        throw new Error(`Expected minLines=12, got ${JSON.stringify(minLines)}`);
      }
      if (minTotalKb !== "8") {
        throw new Error(`Expected minTotalKb=8, got ${JSON.stringify(minTotalKb)}`);
      }
      if (maxKeptLines !== "55") {
        throw new Error(`Expected maxKeptLines=55, got ${JSON.stringify(maxKeptLines)}`);
      }
      if (timeoutSeconds !== "9") {
        throw new Error(`Expected timeoutSeconds=9, got ${JSON.stringify(timeoutSeconds)}`);
      }
    });
  },
};
