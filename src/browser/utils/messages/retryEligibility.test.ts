import { describe, it, expect } from "@jest/globals";
import {
  hasInterruptedStream,
  isEligibleForAutoRetry,
  isNonRetryableSendError,
  PENDING_STREAM_START_GRACE_PERIOD_MS,
} from "./retryEligibility";
import type { DisplayedMessage } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";

describe("hasInterruptedStream", () => {
  it("returns false for empty messages", () => {
    expect(hasInterruptedStream([])).toBe(false);
  });

  it("returns true for stream-error message", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "stream-error",
        id: "error-1",
        historyId: "assistant-1",
        error: "Connection failed",
        errorType: "network",
        historySequence: 2,
      },
    ];
    expect(hasInterruptedStream(messages)).toBe(true);
  });

  it("returns true for partial assistant message", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "assistant",
        id: "assistant-1",
        historyId: "assistant-1",
        content: "Incomplete response",
        historySequence: 2,
        streamSequence: 0,
        isStreaming: false,
        isPartial: true,
        isLastPartOfMessage: true,
        isCompacted: false,
        isIdleCompacted: false,
      },
    ];
    expect(hasInterruptedStream(messages)).toBe(true);
  });

  it("returns false for executing ask_user_question (waiting state)", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "tool",
        id: "tool-1",
        historyId: "assistant-1",
        toolName: "ask_user_question",
        toolCallId: "call-1",
        args: { questions: [] },
        status: "executing",
        isPartial: true,
        historySequence: 2,
        streamSequence: 0,
        isLastPartOfMessage: true,
      },
    ];

    expect(hasInterruptedStream(messages)).toBe(false);
  });
  it("returns true for partial tool message", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "tool",
        id: "tool-1",
        historyId: "assistant-1",
        toolName: "bash",
        toolCallId: "call-1",
        args: { script: "echo test", timeout_secs: 10, display_name: "Test" },
        status: "interrupted",
        isPartial: true,
        historySequence: 2,
        streamSequence: 0,
        isLastPartOfMessage: true,
      },
    ];
    expect(hasInterruptedStream(messages)).toBe(true);
  });

  it("returns true for partial reasoning message", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "reasoning",
        id: "reasoning-1",
        historyId: "assistant-1",
        content: "Let me think...",
        historySequence: 2,
        streamSequence: 0,
        isStreaming: false,
        isPartial: true,
        isLastPartOfMessage: true,
      },
    ];
    expect(hasInterruptedStream(messages)).toBe(true);
  });

  it("returns false for completed messages", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "assistant",
        id: "assistant-1",
        historyId: "assistant-1",
        content: "Complete response",
        historySequence: 2,
        streamSequence: 0,
        isStreaming: false,
        isPartial: false,
        isLastPartOfMessage: true,
        isCompacted: false,
        isIdleCompacted: false,
      },
    ];
    expect(hasInterruptedStream(messages)).toBe(false);
  });

  it("returns true when last message is user message (app restarted during slow model)", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "assistant",
        id: "assistant-1",
        historyId: "assistant-1",
        content: "Complete response",
        historySequence: 2,
        streamSequence: 0,
        isStreaming: false,
        isPartial: false,
        isLastPartOfMessage: true,
        isCompacted: false,
        isIdleCompacted: false,
      },
      {
        type: "user",
        id: "user-2",
        historyId: "user-2",
        content: "Another question",
        historySequence: 3,
      },
    ];
    expect(hasInterruptedStream(messages, null)).toBe(true);
  });

  it("returns false when message was sent very recently (within grace period)", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "assistant",
        id: "assistant-1",
        historyId: "assistant-1",
        content: "Complete response",
        historySequence: 2,
        streamSequence: 0,
        isStreaming: false,
        isPartial: false,
        isLastPartOfMessage: true,
        isCompacted: false,
        isIdleCompacted: false,
      },
      {
        type: "user",
        id: "user-2",
        historyId: "user-2",
        content: "Another question",
        historySequence: 3,
      },
    ];
    // Message sent 1 second ago - still within grace window
    const recentTimestamp = Date.now() - (PENDING_STREAM_START_GRACE_PERIOD_MS - 1000);
    expect(hasInterruptedStream(messages, recentTimestamp)).toBe(false);
  });

  it("returns true when user message has no response (slow model scenario)", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
    ];
    expect(hasInterruptedStream(messages, null)).toBe(true);
  });

  it("returns false when user message just sent (within grace period)", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
    ];
    const justSent = Date.now() - (PENDING_STREAM_START_GRACE_PERIOD_MS - 500);
    expect(hasInterruptedStream(messages, justSent)).toBe(false);
  });

  it("returns true when message sent beyond grace period (stream likely hung)", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
    ];
    const longAgo = Date.now() - (PENDING_STREAM_START_GRACE_PERIOD_MS + 1000);
    expect(hasInterruptedStream(messages, longAgo)).toBe(true);
  });

  describe("stream error types (all show manual retry UI)", () => {
    it("returns true for authentication errors (shows manual retry)", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Invalid API key",
          errorType: "authentication",
          historySequence: 2,
        },
      ];
      expect(hasInterruptedStream(messages)).toBe(true);
    });

    it("returns true for network errors", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Network connection failed",
          errorType: "network",
          historySequence: 2,
        },
      ];
      expect(hasInterruptedStream(messages)).toBe(true);
    });
  });
});

describe("isEligibleForAutoRetry", () => {
  it("returns false for empty messages", () => {
    expect(isEligibleForAutoRetry([])).toBe(false);
  });

  it("returns false for completed messages", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "user",
        id: "user-1",
        historyId: "user-1",
        content: "Hello",
        historySequence: 1,
      },
      {
        type: "assistant",
        id: "assistant-1",
        historyId: "assistant-1",
        content: "Complete response",
        historySequence: 2,
        streamSequence: 0,
        isStreaming: false,
        isPartial: false,
        isLastPartOfMessage: true,
        isCompacted: false,
        isIdleCompacted: false,
      },
    ];
    expect(isEligibleForAutoRetry(messages)).toBe(false);
  });

  describe("non-retryable error types", () => {
    it("returns false for authentication errors (requires user to fix API key)", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Invalid API key",
          errorType: "authentication",
          historySequence: 2,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(false);
    });

    it("returns false for quota errors (requires user to upgrade/wait)", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Usage quota exceeded",
          errorType: "quota",
          historySequence: 2,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(false);
    });

    it("returns false for model_not_found errors (requires user to select different model)", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Model not found",
          errorType: "model_not_found",
          historySequence: 2,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(false);
    });

    it("returns false for context_exceeded errors (requires user to reduce context)", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Context length exceeded",
          errorType: "context_exceeded",
          historySequence: 2,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(false);
    });

    it("returns false for aborted errors (user cancelled)", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Request aborted",
          errorType: "aborted",
          historySequence: 2,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(false);
    });
  });

  describe("retryable error types", () => {
    it("returns true for network errors", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Network connection failed",
          errorType: "network",
          historySequence: 2,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(true);
    });

    it("returns true for server errors", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Internal server error",
          errorType: "server_error",
          historySequence: 2,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(true);
    });

    it("returns true for rate limit errors", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "stream-error",
          id: "error-1",
          historyId: "assistant-1",
          error: "Rate limit exceeded",
          errorType: "rate_limit",
          historySequence: 2,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(true);
    });
  });

  describe("partial messages and user messages", () => {
    it("returns true for partial assistant messages", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "assistant",
          id: "assistant-1",
          historyId: "assistant-1",
          content: "Incomplete response",
          historySequence: 2,
          streamSequence: 0,
          isStreaming: false,
          isPartial: true,
          isLastPartOfMessage: true,
          isCompacted: false,
          isIdleCompacted: false,
        },
      ];
      expect(isEligibleForAutoRetry(messages)).toBe(true);
    });

    it("returns true for trailing user messages (app restart scenario)", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
        {
          type: "assistant",
          id: "assistant-1",
          historyId: "assistant-1",
          content: "Complete response",
          historySequence: 2,
          streamSequence: 0,
          isStreaming: false,
          isPartial: false,
          isLastPartOfMessage: true,
          isCompacted: false,
          isIdleCompacted: false,
        },
        {
          type: "user",
          id: "user-2",
          historyId: "user-2",
          content: "Another question",
          historySequence: 3,
        },
      ];
      expect(isEligibleForAutoRetry(messages, null)).toBe(true);
    });

    it("returns false when user message sent very recently (within grace period)", () => {
      const messages: DisplayedMessage[] = [
        {
          type: "user",
          id: "user-1",
          historyId: "user-1",
          content: "Hello",
          historySequence: 1,
        },
      ];
      const justSent = Date.now() - (PENDING_STREAM_START_GRACE_PERIOD_MS - 500);
      expect(isEligibleForAutoRetry(messages, justSent)).toBe(false);
    });
  });
});

describe("isNonRetryableSendError", () => {
  it("returns true for api_key_not_found error", () => {
    const error: SendMessageError = {
      type: "api_key_not_found",
      provider: "anthropic",
    };
    expect(isNonRetryableSendError(error)).toBe(true);
  });

  it("returns true for provider_not_supported error", () => {
    const error: SendMessageError = {
      type: "provider_not_supported",
      provider: "unknown-provider",
    };
    expect(isNonRetryableSendError(error)).toBe(true);
  });

  it("returns true for invalid_model_string error", () => {
    const error: SendMessageError = {
      type: "invalid_model_string",
      message: "Invalid model format",
    };
    expect(isNonRetryableSendError(error)).toBe(true);
  });

  it("returns false for unknown error", () => {
    const error: SendMessageError = {
      type: "unknown",
      raw: "Some transient error",
    };
    expect(isNonRetryableSendError(error)).toBe(false);
  });

  it("returns true for incompatible_workspace error", () => {
    const error: SendMessageError = {
      type: "incompatible_workspace",
      message: "This workspace uses a runtime configuration from a newer version of mux.",
    };
    expect(isNonRetryableSendError(error)).toBe(true);
  });
});
