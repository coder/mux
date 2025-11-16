import type { Meta, StoryObj } from "@storybook/react-vite";
import { KebabMenu } from "./KebabMenu";
import { action } from "storybook/actions";

const meta = {
  title: "Components/KebabMenu",
  component: KebabMenu,
  parameters: {
    layout: "padded",
  },
  tags: ["autodocs"],
} satisfies Meta<typeof KebabMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    items: [
      { label: "Edit", onClick: action("edit") },
      { label: "Duplicate", onClick: action("duplicate") },
      { label: "Delete", onClick: action("delete") },
    ],
  },
};

export const WithEmojis: Story = {
  args: {
    items: [
      { label: "Start Here", emoji: "🎯", onClick: action("start-here") },
      { label: "Show Text", onClick: action("show-text") },
      { label: "Show JSON", onClick: action("show-json") },
    ],
  },
};

export const WithActiveState: Story = {
  args: {
    items: [
      { label: "Show Markdown", onClick: action("show-markdown") },
      { label: "Show Text", onClick: action("show-text"), active: true },
      { label: "Show JSON", onClick: action("show-json") },
    ],
  },
};

export const WithDisabledItems: Story = {
  args: {
    items: [
      { label: "Edit", onClick: action("edit") },
      { label: "Delete", onClick: action("delete"), disabled: true },
      { label: "Archive", onClick: action("archive") },
    ],
  },
};

export const WithTooltips: Story = {
  args: {
    items: [
      {
        label: "Start Here",
        emoji: "🎯",
        onClick: action("start-here"),
        tooltip: "Replace all chat history with this message",
      },
      { label: "Show Text", onClick: action("show-text"), tooltip: "View raw text" },
      { label: "Show JSON", onClick: action("show-json"), tooltip: "View message as JSON" },
    ],
  },
};

export const ManyItems: Story = {
  args: {
    items: [
      { label: "Copy", onClick: action("copy") },
      { label: "Edit", onClick: action("edit") },
      { label: "Duplicate", onClick: action("duplicate") },
      { label: "Archive", onClick: action("archive") },
      { label: "Share", onClick: action("share") },
      { label: "Export", onClick: action("export") },
      { label: "Delete", onClick: action("delete"), disabled: true },
    ],
  },
};
