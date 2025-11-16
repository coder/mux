import type { Meta, StoryObj } from "@storybook/react-vite";
import { AssistantMessage } from "./AssistantMessage";
import type { DisplayedMessage } from "@/common/types/message";
import { action } from "storybook/actions";

// Stable timestamp for visual testing (Apple demo time: Jan 24, 2024, 9:41 AM PST)
const STABLE_TIMESTAMP = new Date("2024-01-24T09:41:00-08:00").getTime();

const clipboardWriteText = (data: string) => {
  action("copy-text")(data);
  return Promise.resolve();
};

const meta = {
  title: "Messages/AssistantMessage",
  component: AssistantMessage,
  parameters: {
    layout: "padded",
    controls: {
      exclude: ["clipboardWriteText", "className", "workspaceId"],
    },
  },
  tags: ["autodocs"],
  argTypes: {
    message: {
      control: { type: "object" },
      description: "Assistant message data",
    },
    className: {
      control: false,
      description: "Optional CSS class",
    },
    workspaceId: {
      control: false,
      description: "Optional workspace ID for Start Here button",
    },
  },
  args: {
    clipboardWriteText,
  },
} satisfies Meta<typeof AssistantMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

const createAssistantMessage = (
  content: string,
  overrides?: Partial<DisplayedMessage & { type: "assistant" }>
): DisplayedMessage & { type: "assistant" } => ({
  type: "assistant",
  id: "asst-msg-1",
  historyId: "hist-2",
  content,
  historySequence: 2,
  isStreaming: false,
  isPartial: false,
  isCompacted: false,
  timestamp: STABLE_TIMESTAMP,
  model: "anthropic:claude-sonnet-4-5",
  ...overrides,
});

export const BasicMarkdown: Story = {
  args: {
    message: createAssistantMessage(
      "Here's how to fix that issue:\n\n```typescript\nfunction calculate(x: number, y: number): number {\n  return x + y;\n}\n```\n\nThe problem was missing type annotations."
    ),
  },
};

export const WithCodeBlocks: Story = {
  args: {
    message: createAssistantMessage(
      "I'll help you with that. Here are the changes:\n\n" +
        "**File: `src/utils.ts`**\n\n" +
        "```typescript\nexport function formatDate(date: Date): string {\n  return date.toISOString().split('T')[0];\n}\n```\n\n" +
        "**File: `src/App.tsx`**\n\n" +
        "```tsx\nimport { formatDate } from './utils';\n\nconst today = formatDate(new Date());\n```"
    ),
  },
};

export const WithLists: Story = {
  args: {
    message: createAssistantMessage(
      "Here are the main differences:\n\n" +
        "**Props:**\n" +
        "- Simple to use\n" +
        "- Good for small apps\n" +
        "- Can lead to prop drilling\n\n" +
        "**Context:**\n" +
        "- Avoids prop drilling\n" +
        "- Better for medium apps\n" +
        "- Can cause unnecessary re-renders\n\n" +
        "**State Libraries:**\n" +
        "1. Redux - Most mature, verbose\n" +
        "2. Zustand - Simpler, less boilerplate\n" +
        "3. Jotai - Atomic approach"
    ),
  },
};

export const WithTable: Story = {
  args: {
    message: createAssistantMessage(
      "Here's a comparison:\n\n" +
        "| Feature | React Context | Redux | Zustand |\n" +
        "|---------|---------------|-------|----------|\n" +
        "| Learning Curve | Easy | Hard | Easy |\n" +
        "| Boilerplate | Low | High | Low |\n" +
        "| DevTools | No | Yes | Yes |\n" +
        "| Bundle Size | Built-in | ~10KB | ~1KB |"
    ),
  },
};

export const Streaming: Story = {
  args: {
    message: createAssistantMessage("I'm analyzing your code and will provide feedback...", {
      isStreaming: true,
    }),
  },
};

export const StreamingEmpty: Story = {
  args: {
    message: createAssistantMessage("", {
      isStreaming: true,
    }),
  },
};

export const WithModel: Story = {
  args: {
    message: createAssistantMessage(
      "This response uses a specific model that's displayed in the header."
    ),
  },
};

export const DifferentModel: Story = {
  args: {
    message: createAssistantMessage("This uses a different model.", {
      model: "openai:gpt-5-codex",
    }),
  },
};

export const Compacted: Story = {
  args: {
    message: createAssistantMessage(
      "This is a compacted message that was used as a starting point for the conversation.",
      {
        isCompacted: true,
      }
    ),
  },
};

export const CompactedWithWorkspace: Story = {
  args: {
    message: createAssistantMessage(
      "Previous conversation context that was compacted.\n\n" +
        "The user was working on implementing authentication.",
      {
        isCompacted: true,
      }
    ),
    workspaceId: "test-workspace-1",
  },
};

export const Partial: Story = {
  args: {
    message: createAssistantMessage(
      "This message was interrupted before completion due to user stopping the generation...",
      {
        isPartial: true,
      }
    ),
  },
};

export const WithWorkspaceId: Story = {
  args: {
    message: createAssistantMessage(
      "When a workspace ID is provided, the message shows a 'Start Here' button that allows " +
        "compacting the chat history to this point."
    ),
    workspaceId: "test-workspace-1",
  },
};

export const LongResponse: Story = {
  args: {
    message: createAssistantMessage(
      "# Comprehensive Guide to State Management\n\n" +
        "## Introduction\n\n" +
        "State management is a crucial aspect of modern web applications. " +
        "As applications grow in complexity, managing state becomes increasingly important.\n\n" +
        "## Options\n\n" +
        "### 1. Local State\n\n" +
        "Local state using `useState` is perfect for component-specific data:\n\n" +
        "```typescript\nconst [count, setCount] = useState(0);\n```\n\n" +
        "### 2. Context API\n\n" +
        "React Context provides a way to share state across components:\n\n" +
        "```typescript\nconst ThemeContext = createContext('light');\n```\n\n" +
        "### 3. Redux\n\n" +
        "Redux offers predictable state management with actions and reducers:\n\n" +
        "```typescript\nconst store = createStore(reducer);\n```\n\n" +
        "## Best Practices\n\n" +
        "1. Keep state as local as possible\n" +
        "2. Use Context for truly global state\n" +
        "3. Consider Redux for complex applications\n" +
        "4. Normalize your state shape\n\n" +
        "## Conclusion\n\n" +
        "Choose the right tool for your use case. Start simple and add complexity only when needed."
    ),
  },
};

export const WithMermaidDiagram: Story = {
  args: {
    message: createAssistantMessage(
      "Here's the architecture:\n\n" +
        "```mermaid\ngraph TD\n" +
        "  A[User] --> B[Frontend]\n" +
        "  B --> C[API]\n" +
        "  C --> D[Database]\n" +
        "  C --> E[Cache]\n" +
        "```\n\n" +
        "This shows the data flow through the system."
    ),
  },
};

export const EmptyContent: Story = {
  args: {
    message: createAssistantMessage(""),
  },
};

export const LongModelName: Story = {
  args: {
    message: createAssistantMessage(
      "This message has a very long model name that should be truncated to show the end.",
      {
        model: "anthropic:claude-opus-4-20250514-preview-experimental",
      }
    ),
  },
};

export const WithKebabMenu: Story = {
  args: {
    message: createAssistantMessage(
      "The header now uses a kebab menu (⋮) to reduce clutter. " +
        "Click the three dots to see actions like 'Show Text' and 'Show JSON'. " +
        "The 'Copy Text' button remains visible for quick access."
    ),
  },
};
