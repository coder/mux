import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isProviderSupported } from "@/browser/hooks/useGatewayModels";

const BUILT_IN_MODELS: string[] = Object.values(KNOWN_MODELS).map((model) => model.id);

export function getEligibleGatewayModels(config: ProvidersConfigMap | null): string[] {
  const customModels: string[] = [];

  if (config) {
    for (const [provider, providerConfig] of Object.entries(config)) {
      if (provider === "mux-gateway") continue;
      for (const modelId of providerConfig.models ?? []) {
        customModels.push(`${provider}:${modelId}`);
      }
    }
  }

  const unique = new Set<string>();
  for (const modelId of [...customModels, ...BUILT_IN_MODELS]) {
    if (!isProviderSupported(modelId)) continue;
    unique.add(modelId);
  }

  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}
