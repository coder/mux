import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { BackupSection } from "./BackupSection.js";
import { SettingsSectionStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/BackupSection",
  component: BackupSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

function renderBackupSection() {
  return (
    <SettingsSectionStory
      setup={() =>
        createMockORPCClient({
          backupSettings: {
            repoUrl: "git@github.com:example/dotfiles.git",
            branch: "main",
            path: "mux/",
          },
          backupValidation: {
            reachable: true,
            empty: false,
            credential: "gh",
          },
          backupPreview: {
            pushChanges: [
              { status: "M", path: "mux/preferences.json" },
              { status: "A", path: "mux/memory/global/preferences.md" },
            ],
            restoreChanges: [
              { status: "M", path: "preferences.json" },
              { status: "A", path: "skills/release/SKILL.md" },
            ],
            localOnlyFiles: ["agents/local-only.md"],
            redactions: ["mcp.jsonc: github.headers.Authorization"],
          },
        })
      }
    >
      <div className="bg-background min-h-screen p-4 sm:p-6">
        <BackupSection />
      </div>
    </SettingsSectionStory>
  );
}

export const Configured: Story = {
  render: renderBackupSection,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Settings backup");
    await expect(canvas.getByText("API keys and secrets are never included.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Validate" }));
    await canvas.findByText(/Credential used: GitHub CLI/i);
    await userEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Backup to repository");
    await canvas.findByText("Restore to this device");
    await canvas.findByText(/github\.headers\.Authorization/i);
    await canvas.findByText("agents/local-only.md");
    await canvas.findByRole("checkbox", { name: "Override secret scan" });
  },
};

export const Phone: Story = {
  globals: {
    viewport: { value: "mobile2", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  render: renderBackupSection,
};
