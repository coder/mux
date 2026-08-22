import type { MuxMessage, MuxReasoningPart } from "@/common/types/message";

export interface ReasoningProviderMetadata {
  anthropic?: {
    signature?: string;
    redactedData?: string;
  };
  // OpenAI/xAI Responses attach itemId (+ encrypted content under store=false/ZDR)
  // so subsequent turns can restore reasoning without server-side response storage.
  openai?: {
    itemId?: string;
    reasoningEncryptedContent?: string | null;
  };
  xai?: {
    itemId?: string;
    reasoningEncryptedContent?: string | null;
  };
  // Google attaches thought signatures that must be replayed on later turns.
  google?: {
    thoughtSignature?: string;
  };
}

/**
 * Extract replay data from stream providerMetadata into the persisted
 * providerOptions shape. Anthropic needs signatures; OpenAI/xAI Responses
 * need itemId + encrypted content when store=false (ZDR); Google needs
 * thought signatures. Replay happens via attachReasoningReplayMetadata.
 */
export function reasoningProviderOptionsFromMetadata(
  providerMetadata: ReasoningProviderMetadata | undefined
): MuxReasoningPart["providerOptions"] | undefined {
  if (!providerMetadata) return undefined;

  const options: NonNullable<MuxReasoningPart["providerOptions"]> = {};

  const anthropicSignature = providerMetadata.anthropic?.signature;
  if (typeof anthropicSignature === "string" && anthropicSignature.length > 0) {
    options.anthropic = { signature: anthropicSignature };
  }

  const googleThoughtSignature = providerMetadata.google?.thoughtSignature;
  if (typeof googleThoughtSignature === "string" && googleThoughtSignature.length > 0) {
    options.google = { thoughtSignature: googleThoughtSignature };
  }

  for (const provider of ["openai", "xai"] as const) {
    const meta = providerMetadata[provider];
    if (!meta) continue;
    const itemId = typeof meta.itemId === "string" ? meta.itemId : undefined;
    const encrypted =
      typeof meta.reasoningEncryptedContent === "string"
        ? meta.reasoningEncryptedContent
        : meta.reasoningEncryptedContent === null
          ? null
          : undefined;
    if (itemId == null && encrypted === undefined) continue;
    options[provider] = {
      ...(itemId != null ? { itemId } : {}),
      ...(encrypted !== undefined ? { reasoningEncryptedContent: encrypted } : {}),
    };
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

export function mergeReasoningProviderOptions(
  existing: MuxReasoningPart["providerOptions"] | undefined,
  incoming: MuxReasoningPart["providerOptions"] | undefined
): MuxReasoningPart["providerOptions"] | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;

  const merged: NonNullable<MuxReasoningPart["providerOptions"]> = { ...existing };

  if (incoming.anthropic) {
    merged.anthropic = { ...existing.anthropic, ...incoming.anthropic };
  }
  if (incoming.google) {
    merged.google = { ...existing.google, ...incoming.google };
  }
  for (const provider of ["openai", "xai"] as const) {
    if (!incoming[provider]) continue;
    merged[provider] = { ...existing[provider], ...incoming[provider] };
  }

  return merged;
}

/**
 * Request-only shape read by the AI SDK: convertToModelMessages copies UI-part
 * `providerMetadata` into ModelMessage `providerOptions` and ignores any
 * `providerOptions` field on the input part. Never persisted to history.
 */
type ReasoningPartWithReplayMetadata = MuxReasoningPart & {
  providerMetadata?: MuxReasoningPart["providerOptions"];
};

/**
 * Mirror persisted reasoning replay data (`providerOptions`, plus the legacy
 * top-level `signature` field from old histories) into `providerMetadata` so
 * convertToModelMessages passes it through to the provider request. Without
 * this bridge, prior-turn reasoning is silently dropped for every provider.
 * Non-mutating: history objects are reused elsewhere (e.g. debug logging).
 */
export function attachReasoningReplayMetadata(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;

    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "reasoning") return part;

      const legacySignature = part.signature
        ? { anthropic: { signature: part.signature } }
        : undefined;
      // providerOptions wins over the legacy field when both carry a signature.
      const replayMetadata = mergeReasoningProviderOptions(legacySignature, part.providerOptions);
      if (!replayMetadata) return part;

      changed = true;
      const bridged: ReasoningPartWithReplayMetadata = {
        ...part,
        providerMetadata: replayMetadata,
      };
      return bridged;
    });

    return changed ? { ...message, parts } : message;
  });
}

/**
 * Find the start index of the trailing contiguous reasoning-part run.
 * Used so encrypted content on reasoning-end can attach to the first delta part.
 */
export function findFirstReasoningPartIndexInTrailingRun(
  parts: ReadonlyArray<{ type?: string } | undefined>
): number {
  let firstReasoningIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type !== "reasoning") break;
    firstReasoningIndex = i;
  }
  return firstReasoningIndex;
}
