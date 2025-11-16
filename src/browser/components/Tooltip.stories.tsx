import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { TooltipWrapper, Tooltip, HelpIndicator } from "./Tooltip";

const meta = {
  title: "Components/Tooltip",
  component: Tooltip,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BasicTooltip: Story = {
  args: { children: "This is a helpful tooltip" },
  render: () => (
    <TooltipWrapper>
      <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
        Hover me
      </button>
      <Tooltip>This is a helpful tooltip</Tooltip>
    </TooltipWrapper>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Find the button to hover
    const button = canvas.getByRole("button", { name: /hover me/i });

    // Initially tooltip should not be in the document
    let tooltip = document.body.querySelector(".tooltip");
    void expect(tooltip).not.toBeInTheDocument();

    // Hover over the button
    await userEvent.hover(button);

    // Wait for tooltip to appear in document.body (portal)
    await waitFor(
      () => {
        tooltip = document.body.querySelector(".tooltip");
        void expect(tooltip).toBeInTheDocument();
        void expect(tooltip).toHaveTextContent("This is a helpful tooltip");
      },
      { timeout: 2000 }
    );

    // Unhover to hide tooltip
    await userEvent.unhover(button);

    // Wait for tooltip to disappear
    await waitFor(
      () => {
        tooltip = document.body.querySelector(".tooltip");
        void expect(tooltip).not.toBeInTheDocument();
      },
      { timeout: 2000 }
    );
  },
};

export const TooltipPositions: Story = {
  args: { children: "Tooltip content" },
  render: () => (
    <div className="flex flex-wrap gap-5 p-10">
      <TooltipWrapper>
        <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
          Top (default)
        </button>
        <Tooltip position="top">Tooltip appears above</Tooltip>
      </TooltipWrapper>

      <TooltipWrapper>
        <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
          Bottom
        </button>
        <Tooltip position="bottom">Tooltip appears below</Tooltip>
      </TooltipWrapper>
    </div>
  ),
};

export const TooltipAlignments: Story = {
  args: { children: "Tooltip content" },
  render: () => (
    <div className="flex flex-wrap gap-5 p-10">
      <TooltipWrapper>
        <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
          Left Aligned
        </button>
        <Tooltip align="left">Left-aligned tooltip</Tooltip>
      </TooltipWrapper>

      <TooltipWrapper>
        <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
          Center Aligned
        </button>
        <Tooltip align="center">Center-aligned tooltip</Tooltip>
      </TooltipWrapper>

      <TooltipWrapper>
        <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
          Right Aligned
        </button>
        <Tooltip align="right">Right-aligned tooltip</Tooltip>
      </TooltipWrapper>
    </div>
  ),
};

export const WideTooltip: Story = {
  args: { children: "Tooltip content" },
  render: () => (
    <TooltipWrapper>
      <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
        Hover for detailed info
      </button>
      <Tooltip width="wide">
        This is a wider tooltip that can contain more detailed information. It will wrap text
        automatically and has a maximum width of 300px.
      </Tooltip>
    </TooltipWrapper>
  ),
};

export const WithHelpIndicator: Story = {
  args: { children: "Tooltip content" },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <span>Need help?</span>
      <TooltipWrapper inline>
        <HelpIndicator>?</HelpIndicator>
        <Tooltip align="center" width="wide">
          Click here to open the help documentation. You can also press Cmd+Shift+H to quickly
          access help.
        </Tooltip>
      </TooltipWrapper>
    </div>
  ),
};

export const InlineTooltip: Story = {
  args: { children: "Tooltip content" },
  render: () => (
    <div style={{ fontSize: "14px", fontFamily: "var(--font-primary)" }}>
      This is some text with an{" "}
      <TooltipWrapper inline>
        <span style={{ color: "#0e639c", cursor: "pointer", textDecoration: "underline" }}>
          inline tooltip
        </span>
        <Tooltip>Additional context appears here</Tooltip>
      </TooltipWrapper>{" "}
      embedded in the sentence.
    </div>
  ),
};

export const KeyboardShortcut: Story = {
  args: { children: "Tooltip content" },
  render: () => (
    <TooltipWrapper>
      <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
        Save File
      </button>
      <Tooltip align="center">
        Save File <kbd>⌘S</kbd>
      </Tooltip>
    </TooltipWrapper>
  ),
};

export const LongContent: Story = {
  args: { children: "Tooltip content" },
  render: () => (
    <TooltipWrapper>
      <button className="bg-accent-dark font-primary hover:bg-accent-hover cursor-pointer rounded border-none px-4 py-2 text-[13px] text-white">
        Documentation
      </button>
      <Tooltip width="wide">
        <strong>Getting Started:</strong>
        <br />
        1. Create a new workspace
        <br />
        2. Select your preferred model
        <br />
        3. Start chatting with the AI
        <br />
        <br />
        Press Cmd+K to open the command palette.
      </Tooltip>
    </TooltipWrapper>
  ),
};
