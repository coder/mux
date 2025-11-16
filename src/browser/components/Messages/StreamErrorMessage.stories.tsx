import type { Meta, StoryObj } from "@storybook/react-vite";
import { StreamErrorMessage } from "./StreamErrorMessage";
import type { DisplayedMessage } from "@/common/types/message";
import type { StreamErrorType } from "@/common/types/errors";

// Stable timestamp for visual testing (Apple demo time: Jan 24, 2024, 9:41 AM PST)
const STABLE_TIMESTAMP = new Date("2024-01-24T09:41:00-08:00").getTime();

const meta = {
  title: "Messages/StreamErrorMessage",
  component: StreamErrorMessage,
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
      description: "Stream error message data",
    },
  },
} satisfies Meta<typeof StreamErrorMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

const createStreamErrorMessage = (
  error: string,
  errorType: StreamErrorType,
  overrides?: Partial<DisplayedMessage & { type: "stream-error" }>
): DisplayedMessage & { type: "stream-error" } => ({
  type: "stream-error",
  id: "error-msg-1",
  historyId: "hist-error-1",
  error,
  errorType,
  historySequence: 1,
  timestamp: STABLE_TIMESTAMP,
  ...overrides,
});

export const NetworkError: Story = {
  args: {
    message: createStreamErrorMessage(
      "Failed to connect to the API server. Please check your network connection.",
      "network"
    ),
  },
};

export const RateLimitError: Story = {
  args: {
    message: createStreamErrorMessage(
      "Rate limit exceeded. Please wait before making another request.",
      "rate_limit"
    ),
  },
};

export const AuthenticationError: Story = {
  args: {
    message: createStreamErrorMessage(
      "Invalid API key. Please check your configuration and try again.",
      "authentication"
    ),
  },
};

export const TimeoutError: Story = {
  args: {
    message: createStreamErrorMessage(
      "Request timed out after 30 seconds. The server may be experiencing high load.",
      "unknown"
    ),
  },
};

export const ServerError: Story = {
  args: {
    message: createStreamErrorMessage(
      "Internal server error (500). The service is temporarily unavailable.",
      "server_error"
    ),
  },
};

export const ValidationError: Story = {
  args: {
    message: createStreamErrorMessage(
      "Invalid request: message content is empty or malformed.",
      "api"
    ),
  },
};

export const WithErrorCount: Story = {
  args: {
    message: createStreamErrorMessage(
      "Connection refused. The server is not responding.",
      "network",
      {
        errorCount: 3,
      }
    ),
  },
};

export const HighErrorCount: Story = {
  args: {
    message: createStreamErrorMessage("Request failed due to network instability.", "network", {
      errorCount: 15,
    }),
  },
};

export const LongErrorMessage: Story = {
  args: {
    message: createStreamErrorMessage(
      "An unexpected error occurred while processing your request. " +
        "The error details are: Error: ECONNREFUSED - Connection refused at TCPConnectWrap.afterConnect " +
        "(net.js:1148:16). This typically indicates that the server is not running or is not accessible " +
        "from your current network location. Please verify that the API endpoint is correct and that " +
        "you have proper network connectivity.",
      "network"
    ),
  },
};

export const WithStackTrace: Story = {
  args: {
    message: createStreamErrorMessage(
      "TypeError: Cannot read property 'content' of undefined\n" +
        "    at processMessage (stream.js:245:32)\n" +
        "    at handleChunk (stream.js:189:18)\n" +
        "    at Stream.<anonymous> (stream.js:142:9)\n" +
        "    at Stream.emit (events.js:315:20)",
      "unknown"
    ),
  },
};

export const GenericError: Story = {
  args: {
    message: createStreamErrorMessage("An unknown error occurred.", "unknown"),
  },
};
