import { appMeta, AppWithMocks, type AppStory } from "@/browser/stories/meta.js";
import { within, userEvent } from "@storybook/test";
import { setupSettingsStory } from "./Sections/settingsStoryUtils.js";

export default {
  ...appMeta,
  title: "Settings/SettingsPage",
};

const BASE_SECTION_LABELS = [
  "General",
  "Agents",
  "Providers",
  "Models",
  "MCP",
  "Secrets",
  "Security",
  "Server Access",
  "Layouts",
  "Runtimes",
  "Experiments",
  "Keybinds",
] as const;

async function openSettings(canvasElement: HTMLElement): Promise<void> {
  const canvas = within(canvasElement);

  const settingsButton = await canvas.findByTestId("settings-button", {}, { timeout: 10000 });
  await userEvent.click(settingsButton);
}

async function clickSectionButton(canvasElement: HTMLElement, sectionLabel: string): Promise<void> {
  const canvas = within(canvasElement);

  // Desktop + mobile settings nav buttons can both exist in the test DOM.
  const sectionButtons = await canvas.findAllByRole("button", {
    name: new RegExp(`^${sectionLabel}$`, "i"),
  });
  const sectionButton = sectionButtons[0];
  if (!sectionButton) {
    throw new Error(`Settings section button not found for ${sectionLabel}`);
  }

  await userEvent.click(sectionButton);
}

export const SectionsSmoke: AppStory = {
  render: () => <AppWithMocks setup={() => setupSettingsStory({})} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await openSettings(canvasElement);

    for (const sectionLabel of BASE_SECTION_LABELS) {
      await clickSectionButton(canvasElement, sectionLabel);
    }
  },
};
