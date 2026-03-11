import { AlertTriangle } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { getModelProvider } from "@/common/utils/ai/models";
import {
  PROVIDER_DEFINITIONS,
  PROVIDER_DISPLAY_NAMES,
  type ProviderName,
} from "@/common/constants/providers";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isProviderSupported } from "@/browser/hooks/useGatewayModels";

interface Props {
  activeModel: string;
  providersConfig: ProvidersConfigMap | null;
  onOpenProviders: () => void;
}

/**
 * Returns the provider key if the active model's provider is not configured (disabled or
 * missing credentials), and the model is NOT being routed through Mux Gateway.
 * Returns null when no warning is needed.
 */
export function getUnconfiguredProvider(
  activeModel: string,
  config: ProvidersConfigMap | null
): string | null {
  if (config == null) return null; // Config still loading — avoid false positives.

  const provider = getModelProvider(activeModel);
  if (!provider) return null;

  const info = config[provider];
  // Unknown providers are treated as available (same logic as useModelsFromSettings).
  if (!info) return null;

  if (info.isEnabled && info.isConfigured) return null;

  // If the model is routed through Mux Gateway, the native provider credentials aren't needed.
  const gwConfig = config["mux-gateway"];
  const gatewayActive = (gwConfig?.couponCodeSet ?? false) && (gwConfig?.isEnabled ?? true);
  if (gatewayActive && isProviderSupported(activeModel)) {
    const gatewayModels = gwConfig?.gatewayModels ?? [];
    if (gatewayModels.includes(activeModel)) return null;
  }

  return provider;
}

export function ProviderNotConfiguredBanner(props: Props) {
  const provider = getUnconfiguredProvider(props.activeModel, props.providersConfig);
  if (!provider) return null;

  const displayName = PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider;
  const info = props.providersConfig?.[provider];
  const isDisabled = info != null && !info.isEnabled;
  const definition = PROVIDER_DEFINITIONS[provider as ProviderName];
  // Providers like bedrock/ollama don't use API keys — use generic guidance.
  const usesApiKey = definition?.requiresApiKey !== false;

  return (
    <div
      data-testid="provider-not-configured-banner"
      className="bg-warning/10 border-warning/30 text-warning mt-1 mb-2 flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="leading-relaxed">
          <span className="font-medium">
            {isDisabled
              ? `${displayName} provider is disabled.`
              : usesApiKey
                ? `API key required for ${displayName}.`
                : `${displayName} is not configured.`}
          </span>{" "}
          Open Settings → Providers to{" "}
          {isDisabled
            ? "enable this provider"
            : usesApiKey
              ? "add an API key"
              : "configure this provider"}{" "}
          before sending.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={props.onOpenProviders}
        className="border-warning/40 text-warning hover:bg-warning/15 hover:text-warning shrink-0"
      >
        Providers
      </Button>
    </div>
  );
}
