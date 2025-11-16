import type { Meta, StoryObj } from "@storybook/react-vite";
import { HistoryHiddenMessage } from "./HistoryHiddenMessage";
import type { DisplayedMessage } from "@/common/types/message";

const meta = {
  title: "Messages/HistoryHiddenMessage",
  component: HistoryHiddenMessage,
  parameters: {
    layout: "padded",
    controls: {
      exclude: ["className"],
    },
  },
  tags: ["autodocs"],
  argTypes: {
    message: {
      control: "object",
      description: "History hidden indicator message",
    },
  },
} satisfies Meta<typeof HistoryHiddenMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

const createHistoryHiddenMessage = (
  hiddenCount: number
): DisplayedMessage & { type: "history-hidden" } => ({
  type: "history-hidden",
  id: `hidden-msg-${hiddenCount}`,
  hiddenCount,
  historySequence: 1,
});

export const SingleMessage: Story = {
  args: {
    message: createHistoryHiddenMessage(1),
  },
};

export const FewMessages: Story = {
  args: {
    message: createHistoryHiddenMessage(5),
  },
};

export const ManyMessages: Story = {
  args: {
    message: createHistoryHiddenMessage(42),
  },
};

export const HundredsOfMessages: Story = {
  args: {
    message: createHistoryHiddenMessage(234),
  },
};

export const ThousandsOfMessages: Story = {
  args: {
    message: createHistoryHiddenMessage(1567),
  },
};
