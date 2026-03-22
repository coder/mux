import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { KeybindsSection } from "./KeybindsSection.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/KeybindsSection",
  component: KeybindsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Keybinds: Story = {
  render: () => <KeybindsSection />,
};
