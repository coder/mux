/**
 * Route-aware pro-mode availability for UI surfaces (PRO toggle, palette command).
 *
 * Mirrors the send path's provider-option gating so the UI never offers a toggle that
 * cannot affect the request:
 * - model must be pro-capable (the GPT-5.6 family — openaiSupportsProMode);
 * - pro mode is a Responses API field, so `wireFormat: "chatCompletions"` disables it;
 * - only the direct `openai:` route delivers the mode. Gateways hide it:
 *   non-passthrough ones use another provider schema, and mux-gateway currently
 *   drops `providerOptions.openai.reasoningMode` server-side (verified empirically —
 *   the Responses API echoed `mode: "standard"`), so it fails closed until the
 *   gateway forwards the field;
 * - Codex OAuth routes strip `reasoning.mode` before calling the stricter ChatGPT
 *   backend, so when OAuth is the effective auth path, pro mode is unavailable too.
 *
 * Lives in its own module because the Codex OAuth mirror imports the codexOAuth
 * constants, which sit above models.ts in the import graph (codexOAuth →
 * modelEntries → models); adding it to models.ts would create a cycle.
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { openaiSupportsProMode } from "@/common/types/thinking";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { wouldRouteOpenAIThroughCodexOauth } from "@/common/utils/providers/codexOauthRouting";

export interface ProModeAvailabilityOptions {
  /** Overrides the providersConfig-derived OpenAI wire format when provided. */
  openaiWireFormat?: "responses" | "chatCompletions" | null;
  /** Settings-resolved route for the canonical model ("direct" = no gateway). */
  resolvedRouteProvider?: string | null;
  /** Providers config for wire format + Codex OAuth auth-path detection. */
  providersConfig?: ProvidersConfigMap | null;
}

export function openaiProModeAvailable(
  modelString: string,
  options?: ProModeAvailabilityOptions
): boolean {
  const wireFormat =
    options?.openaiWireFormat ?? options?.providersConfig?.openai?.wireFormat ?? "responses";
  if (wireFormat === "chatCompletions") {
    return false;
  }
  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);
  if (origin !== "openai") {
    return false;
  }

  // Mapped aliases (models: [{ id, mappedToModel }]) inherit capabilities from
  // their target, mirroring buildProviderOptions' capabilityModel resolution.
  const capabilityModel = resolveModelForMetadata(normalized, options?.providersConfig ?? null);
  if (!openaiSupportsProMode(capabilityModel)) {
    return false;
  }

  // Direct-only: any gateway route (explicit model-string prefix or
  // settings-resolved) fails closed — including mux-gateway, which drops the
  // native provider option today. Unknown routes fail closed too.
  //
  // An explicit prefix only wins the route while the gateway can actually
  // serve it: the backend (resolveModelString) preserves the prefix only when
  // the gateway is configured and enabled, and otherwise falls back to the
  // settings-resolved route — which may be direct OpenAI, where pro mode
  // works. Mirror that here so the toggle isn't hidden in the fallback case.
  // Without a providersConfig we cannot tell, so fail closed conservatively.
  const explicitGateway = getExplicitGatewayPrefix(modelString);
  if (explicitGateway != null) {
    const gatewayConfig = options?.providersConfig?.[explicitGateway];
    const gatewayDefinition = PROVIDER_DEFINITIONS[explicitGateway];
    const gatewayWinsRoute =
      options?.providersConfig == null ||
      (gatewayConfig?.isConfigured === true &&
        gatewayConfig.isEnabled !== false &&
        gatewayDefinition.kind === "gateway" &&
        // Each gateway definition narrows routes to its literal tuple; widen for the membership check.
        (gatewayDefinition.routes as readonly string[]).includes("openai"));
    if (gatewayWinsRoute) {
      return false;
    }
  }
  const resolvedRouteProvider = options?.resolvedRouteProvider;
  if (resolvedRouteProvider != null && resolvedRouteProvider !== "direct") {
    return false;
  }

  // Codex OAuth routes strip reasoning.mode before forwarding. Checked
  // after route resolution so the exclusion only applies to direct OpenAI
  // routing — gateway sends never use Codex OAuth (they fail closed above).
  return !(
    options?.providersConfig != null &&
    wouldRouteOpenAIThroughCodexOauth(normalized, options.providersConfig)
  );
}
