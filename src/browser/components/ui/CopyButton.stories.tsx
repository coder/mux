import type { Meta, StoryObj } from "@storybook/react-vite";
import { CopyButton } from "./CopyButton";

const meta: Meta<typeof CopyButton> = {
  title: "UI/CopyButton",
  component: CopyButton,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof CopyButton>;

export const Default: Story = {
  args: {
    text: "Hello, world! This text will be copied to your clipboard.",
  },
};

export const LongText: Story = {
  args: {
    text: `function example() {
  console.log("This is a longer example");
  return "Copy this entire function";
}`,
  },
};

export const CustomFeedback: Story = {
  args: {
    text: "Quick copy test",
    feedbackDuration: 1000,
  },
  parameters: {
    docs: {
      description: {
        story: "The feedback duration can be customized (1 second in this example)",
      },
    },
  },
};

export const InContext: Story = {
  render: () => (
    <div
      style={{
        background: "var(--color-code-bg)",
        padding: "20px",
        borderRadius: "8px",
        position: "relative",
        width: "400px",
      }}
    >
      <p style={{ margin: 0, fontFamily: "monospace", fontSize: "14px" }}>
        Some content that can be copied...
        <br />
        Multiple lines...
        <br />
        With a copy button!
      </p>
      <CopyButton
        text="Some content that can be copied...
Multiple lines...
With a copy button!"
        className="code-copy-button"
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Example showing the copy button positioned in the bottom-right corner (hover to reveal)",
      },
    },
  },
};
