/**
 * Route-aware pro-mode availability for UI surfaces (PRO toggle, palette command).
 *
 * Mirrors the send path's wire gating so the UI never offers a toggle that
 * cannot affect the request:
 * - model must be pro-capable (GPT-5.6 Sol/Terra — openaiSupportsProMode);
 * - pro mode is a Responses API field, so `wireFormat: "chatCompletions"`
 *   disables it (the OpenAI fetch wrapper only rewrites /responses bodies);
 * - only routes that flow through our OpenAI fetch wrapper inject the mode:
 *   direct `openai:` or passthrough gateways (mux-gateway). Explicit
 *   non-passthrough gateway model strings (openrouter:openai/...,
 *   github-copilot:...) and settings-resolved non-passthrough routes hide it;
 * - Codex OAuth routes never inject (`inject: false` — the ChatGPT backend is
 *   stricter than the public API), so when OAuth is the effective auth path
 *   for the model, pro mode is unavailable too.
 *
 * Lives in its own module because the Codex OAuth mirror imports the codexOAuth
 * constants, which sit above models.ts in the import graph (codexOAuth →
 * modelEntries → models); adding it to models.ts would create a cycle.
 */

import type { ProvidersConfigMap } from "@/common/orpc/types";
import { openaiSupportsProMode } from "@/common/types/thinking";
import {
  getExplicitGatewayPrefix,
  normalizeToCanonical,
  resolveProviderOptionsNamespaceKey,
} from "@/common/utils/ai/models";
import { wouldRouteOpenAIThroughCodexOauth } from "@/common/utils/providers/codexOauthRouting";
import type { ProviderName } from "@/common/constants/providers";

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
  if (!openaiSupportsProMode(modelString)) {
    return false;
  }

  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);
  if (origin !== "openai") {
    return false;
  }

  // Codex OAuth routes strip the pro-mode header without injecting.
  if (
    options?.providersConfig != null &&
    wouldRouteOpenAIThroughCodexOauth(normalized, options.providersConfig)
  ) {
    return false;
  }

  // Prefer an explicit gateway prefix on the model string; otherwise use the
  // settings-resolved route ("direct" means no gateway). Unknown routes fail
  // closed: resolveProviderOptionsNamespaceKey returns the route itself for
  // non-passthrough definitions, hiding pro rather than showing an inert toggle.
  const resolvedRouteProvider = options?.resolvedRouteProvider;
  const routeProvider =
    getExplicitGatewayPrefix(modelString) ??
    (resolvedRouteProvider != null && resolvedRouteProvider !== "direct"
      ? (resolvedRouteProvider as ProviderName)
      : undefined);
  return resolveProviderOptionsNamespaceKey(origin, routeProvider) === origin;
}
