/**
 * Per-request HTTP headers for provider-specific features.
 *
 * These flow through streamText({ headers }) to the provider SDK, which merges
 * them with provider-creation-time headers via combineHeaders(). This is the
 * single injection site for features like the Anthropic 1M context beta header,
 * regardless of whether the model is direct or gateway-routed.
 *
 * Mirrors the pattern of buildProviderOptions() — normalizes gateway model
 * strings before branching on provider.
 */

import { normalizeGatewayModel, supports1MContext } from "@/common/utils/ai/models";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { ANTHROPIC_1M_CONTEXT_HEADER } from "@/node/services/providerModelFactory";

export function buildRequestHeaders(
  modelString: string,
  muxProviderOptions?: MuxProviderOptions
): Record<string, string> | undefined {
  const normalized = normalizeGatewayModel(modelString);
  const [provider] = normalized.split(":", 2);

  if (provider !== "anthropic") return undefined;

  const is1MEnabled =
    ((muxProviderOptions?.anthropic?.use1MContextModels?.includes(normalized) ?? false) ||
      muxProviderOptions?.anthropic?.use1MContext === true) &&
    supports1MContext(normalized);

  if (!is1MEnabled) return undefined;
  return { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER };
}
