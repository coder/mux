import type { Meta, StoryObj } from "@storybook/react-vite";
import { ErrorMessage } from "./ErrorMessage";

const meta = {
  title: "Components/ErrorMessage",
  component: ErrorMessage,
  parameters: {
    layout: "padded",
  },
  tags: ["autodocs"],
  argTypes: {
    title: {
      control: "text",
      description: "Optional title for the error message",
    },
    message: {
      control: "text",
      description: "Main error message",
    },
    details: {
      control: "text",
      description: "Optional additional details",
    },
  },
} satisfies Meta<typeof ErrorMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    message: "Something went wrong",
  },
};

export const WithTitle: Story = {
  args: {
    title: "Configuration Error",
    message: "Failed to load workspace configuration",
  },
};

export const WithDetails: Story = {
  args: {
    title: "API Error",
    message: "Failed to fetch data from server",
    details: "Error: Connection timeout after 30s\nStatus: 504 Gateway Timeout",
  },
};

export const LongMessage: Story = {
  args: {
    title: "Build Failed",
    message:
      "The build process failed with multiple errors. This is a very long error message that demonstrates how the component handles multi-line content and word wrapping. The component should wrap text appropriately and maintain readability even with lengthy error messages.",
    details:
      "Stack trace:\n  at buildProject (src/build.ts:45)\n  at main (src/index.ts:12)\n  at process._tickCallback (internal/process/next_tick.js:68)",
  },
};

export const MessageOnly: Story = {
  args: {
    message: "File not found: /path/to/missing/file.txt",
  },
};

export const NetworkError: Story = {
  args: {
    title: "Network Request Failed",
    message: "Unable to connect to the API server",
    details: "ECONNREFUSED: Connection refused at localhost:3000",
  },
};
