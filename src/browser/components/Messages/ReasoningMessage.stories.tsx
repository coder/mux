import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReasoningMessage } from "./ReasoningMessage";
import type { DisplayedMessage } from "@/common/types/message";

// Stable timestamp for visual testing (Apple demo time: Jan 24, 2024, 9:41 AM PST)
const STABLE_TIMESTAMP = new Date("2024-01-24T09:41:00-08:00").getTime();

const meta = {
  title: "Messages/ReasoningMessage",
  component: ReasoningMessage,
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
      description: "Reasoning message data",
    },
  },
} satisfies Meta<typeof ReasoningMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

const createReasoningMessage = (
  content: string,
  overrides?: Partial<DisplayedMessage & { type: "reasoning" }>
): DisplayedMessage & { type: "reasoning" } => ({
  type: "reasoning",
  id: "reasoning-msg-1",
  historyId: "hist-reasoning-1",
  content,
  historySequence: 1,
  isStreaming: false,
  isPartial: false,
  timestamp: STABLE_TIMESTAMP,
  ...overrides,
});

export const Basic: Story = {
  args: {
    message: createReasoningMessage(
      "I need to analyze the code structure first to understand the dependencies before making changes.",
      { isStreaming: true }
    ),
  },
};

export const MultiParagraph: Story = {
  args: {
    message: createReasoningMessage(
      "First, I'll check the current implementation to see how the state is managed.\n\n" +
        "Then I'll identify the specific areas where the bug might be occurring.\n\n" +
        "Finally, I'll propose a solution that maintains backward compatibility.",
      { isStreaming: true }
    ),
  },
};

export const Empty: Story = {
  args: {
    message: createReasoningMessage("", {
      isStreaming: true,
    }),
  },
};

export const LongReasoning: Story = {
  args: {
    message: createReasoningMessage(
      "Looking at this problem, I need to consider several factors:\n\n" +
        "1. The current architecture uses a centralized state management approach, " +
        "which means any changes need to be carefully coordinated.\n\n" +
        "2. The component hierarchy suggests that prop drilling might be an issue, " +
        "so I should consider using Context or a state library.\n\n" +
        "3. Performance is a concern here since we're dealing with frequent updates. " +
        "I'll need to ensure we're not causing unnecessary re-renders.\n\n" +
        "4. The existing tests assume a certain behavior, so I need to verify " +
        "that my changes won't break the test suite.\n\n" +
        "Based on these considerations, I think the best approach is to...",
      { isStreaming: true }
    ),
  },
};

export const WithCodeAnalysis: Story = {
  args: {
    message: createReasoningMessage(
      "The function signature indicates this is expecting a callback, but the current " +
        "implementation passes a promise. This mismatch is likely causing the error.\n\n" +
        "I should refactor the code to either:\n" +
        "- Wrap the promise in a callback, or\n" +
        "- Update the function to accept promises directly",
      { isStreaming: true }
    ),
  },
};

export const PlanningSteps: Story = {
  args: {
    message: createReasoningMessage(
      "To solve this, I'll follow these steps:\n\n" +
        "**Step 1:** Identify the root cause by examining the error stack trace\n\n" +
        "**Step 2:** Review the related code to understand the context\n\n" +
        "**Step 3:** Implement a fix that addresses the core issue\n\n" +
        "**Step 4:** Add tests to prevent regression\n\n" +
        "Let me start with Step 1...",
      { isStreaming: true }
    ),
  },
};

export const DecisionMaking: Story = {
  args: {
    message: createReasoningMessage(
      "I'm considering two approaches:\n\n" +
        "**Option A:** Refactor the entire component\n" +
        "- Pros: Clean solution, better maintainability\n" +
        "- Cons: Higher risk, more changes\n\n" +
        "**Option B:** Minimal patch to fix the immediate issue\n" +
        "- Pros: Lower risk, quick fix\n" +
        "- Cons: Technical debt, may need revisiting\n\n" +
        "Given the time constraints and risk profile, I recommend Option B for now.",
      { isStreaming: true }
    ),
  },
};

export const EmptyContent: Story = {
  args: {
    message: createReasoningMessage(""),
  },
};
export const ExpandablePreview: Story = {
  args: {
    message: createReasoningMessage(
      "Assessing quicksort mechanics and choosing example array...\n" +
        "Plan: explain pivot selection, partitioning, recursion, base case.\n" +
        "Next, I'll outline best practices for implementing the partition step.",
      { isStreaming: false }
    ),
  },
};
