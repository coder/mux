import type { ScenarioTurn } from "@/node/services/mock/scenarioTypes";
import { STREAM_BASE_DELAY } from "@/node/services/mock/scenarioTypes";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

export const ERROR_PROMPTS = {
  TRIGGER_RATE_LIMIT: "Trigger rate limit error",
  TRIGGER_API_ERROR: "Trigger API error",
  TRIGGER_NETWORK_ERROR: "Trigger network error",
} as const;

export const ERROR_MESSAGES = {
  RATE_LIMIT: "Rate limit exceeded. Please retry after 60 seconds.",
  API_ERROR: "Internal server error occurred while processing the request.",
  NETWORK_ERROR: "Network connection lost. Please check your internet connection.",
} as const;

const rateLimitErrorTurn: ScenarioTurn = {
  user: {
    text: ERROR_PROMPTS.TRIGGER_RATE_LIMIT,
    thinkingLevel: "low",
    mode: "exec",
  },
  assistant: {
    messageId: "msg-error-ratelimit",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-error-ratelimit",
        model: KNOWN_MODELS.GPT.id,
      },
      {
        kind: "stream-delta",
        delay: STREAM_BASE_DELAY,
        text: "Processing your request...",
      },
      {
        kind: "stream-error",
        delay: STREAM_BASE_DELAY * 2,
        error: ERROR_MESSAGES.RATE_LIMIT,
        errorType: "rate_limit",
      },
    ],
  },
};

const apiErrorTurn: ScenarioTurn = {
  user: {
    text: ERROR_PROMPTS.TRIGGER_API_ERROR,
    thinkingLevel: "low",
    mode: "exec",
  },
  assistant: {
    messageId: "msg-error-api",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-error-api",
        model: KNOWN_MODELS.GPT.id,
      },
      {
        kind: "stream-error",
        delay: STREAM_BASE_DELAY,
        error: ERROR_MESSAGES.API_ERROR,
        errorType: "server_error",
      },
    ],
  },
};

const networkErrorTurn: ScenarioTurn = {
  user: {
    text: ERROR_PROMPTS.TRIGGER_NETWORK_ERROR,
    thinkingLevel: "low",
    mode: "exec",
  },
  assistant: {
    messageId: "msg-error-network",
    events: [
      {
        kind: "stream-start",
        delay: 0,
        messageId: "msg-error-network",
        model: KNOWN_MODELS.GPT.id,
      },
      {
        kind: "stream-error",
        delay: STREAM_BASE_DELAY,
        error: ERROR_MESSAGES.NETWORK_ERROR,
        errorType: "network",
      },
    ],
  },
};

export const scenarios: ScenarioTurn[] = [rateLimitErrorTurn, apiErrorTurn, networkErrorTurn];
