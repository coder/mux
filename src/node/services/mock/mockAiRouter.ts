import type { MuxMessage, ContinueMessage } from "@/common/types/message";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

export type MockAiMode = "scenario" | "router";

export function readMockAiModeFromEnv(env: NodeJS.ProcessEnv = process.env): MockAiMode {
  const raw = env.MUX_MOCK_AI_MODE;
  if (raw === "scenario" || raw === "router") {
    return raw;
  }
  // Default to router so tests don't need prompt-exact transcripts.
  return "router";
}

export interface MockAiRouterRequest {
  messages: MuxMessage[];
  latestUserMessage: MuxMessage;
  latestUserText: string;
}

export interface MockAiRouterReply {
  assistantText: string;
  /** Optional: stream-start mode (exec/plan/compact). */
  mode?: "plan" | "exec" | "compact";
  /** Optional: if present, the mock adapter will emit a usage-delta early in the stream. */
  usage?: LanguageModelV2Usage;
}

export interface MockAiRouterHandler {
  match(request: MockAiRouterRequest): boolean;
  respond(request: MockAiRouterRequest): MockAiRouterReply;
}

const DEFAULT_FORCE_COMPACTION_INPUT_TOKENS = 160_000;
const FORCE_MARKER = "[force]";

function isCompactionRequest(message: MuxMessage): ContinueMessage | undefined {
  const muxMeta = message.metadata?.muxMetadata;
  if (!muxMeta || muxMeta.type !== "compaction-request") {
    return undefined;
  }
  return muxMeta.parsed.continueMessage;
}

function buildUsage(inputTokens: number, outputTokens: number): LanguageModelV2Usage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function buildMockCompactionSummary(options: {
  preCompactionMessages: MuxMessage[];
  continueMessage?: ContinueMessage;
}): string {
  const userCount = options.preCompactionMessages.filter((m) => m.role === "user").length;
  const assistantCount = options.preCompactionMessages.filter((m) => m.role === "assistant").length;
  const totalCount = options.preCompactionMessages.length;

  const continueText = options.continueMessage?.text?.trim();

  return [
    "Mock compaction summary:",
    `Messages: ${totalCount} (user: ${userCount}, assistant: ${assistantCount})`,
    ...(continueText ? [`Continue with: ${continueText}`] : []),
  ].join("\n");
}

function buildDefaultReply(latestUserText: string): MockAiRouterReply {
  const trimmed = latestUserText.trim();
  return {
    assistantText: trimmed.length > 0 ? `Mock response: ${trimmed}` : "Mock response: <empty>",
  };
}

function buildForceCompactionReply(): MockAiRouterReply {
  // Intentionally long to keep the stream alive long enough for UI force-compaction effects.
  const assistantText = Array.from({ length: 120 }, () => "Streaming response...").join(" ");

  return {
    assistantText,
    usage: buildUsage(DEFAULT_FORCE_COMPACTION_INPUT_TOKENS, 1),
  };
}

const defaultHandlers: MockAiRouterHandler[] = [
  {
    match: (request) => request.latestUserText.toLowerCase().includes(FORCE_MARKER),
    respond: () => buildForceCompactionReply(),
  },
  {
    match: (request) => Boolean(isCompactionRequest(request.latestUserMessage)),
    respond: (request) => {
      const continueMessage = isCompactionRequest(request.latestUserMessage);
      const preCompactionMessages = request.messages.slice(0, -1);
      return {
        assistantText: buildMockCompactionSummary({
          preCompactionMessages,
          continueMessage,
        }),
        mode: "compact",
      };
    },
  },
  {
    match: () => true,
    respond: (request) => buildDefaultReply(request.latestUserText),
  },
];

/**
 * Stream-agnostic, pattern-based mock LLM router.
 *
 * IMPORTANT: This module is intentionally *not* aware of stream event semantics
 * (stream-delta, stream-end, etc). It returns a high-level reply which is
 * converted to stream events by a dedicated adapter.
 */
export class MockAiRouter {
  private readonly handlers: MockAiRouterHandler[];

  constructor(handlers: MockAiRouterHandler[] = defaultHandlers) {
    this.handlers = handlers;
  }

  route(request: MockAiRouterRequest): MockAiRouterReply {
    for (const handler of this.handlers) {
      if (handler.match(request)) {
        return handler.respond(request);
      }
    }

    return buildDefaultReply(request.latestUserText);
  }
}
