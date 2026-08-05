import type { MuxReasoningPart } from "@/common/types/message";

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
}

/**
 * Build providerOptions for reasoning parts that convertToModelMessages must
 * pass back to the provider. Anthropic needs signatures; OpenAI/xAI Responses
 * need itemId + encrypted content when store=false (ZDR).
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
  for (const provider of ["openai", "xai"] as const) {
    if (!incoming[provider]) continue;
    merged[provider] = { ...existing[provider], ...incoming[provider] };
  }

  return merged;
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
