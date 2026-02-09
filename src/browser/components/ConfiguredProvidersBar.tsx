import { Check, Settings } from "lucide-react";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { getAllowedProvidersForUi } from "@/browser/utils/policyUi";
import { hasProviderIcon, ProviderIcon } from "./ProviderIcon";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface ConfiguredProvidersBarProps {
  providersConfig: ProvidersConfigMap;
}

/**
 * Compact horizontal bar showing configured provider icons with a link to add more.
 * Displayed above ChatInput on the Project page.
 */
export function ConfiguredProvidersBar(props: ConfiguredProvidersBarProps) {
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const visibleProviders = getAllowedProvidersForUi(effectivePolicy);

  const settings = useSettings();
  const configuredProviders = visibleProviders.filter(
    (p) => props.providersConfig[p]?.isConfigured
  );

  const handleOpenProviders = () => {
    settings.open("providers");
  };

  const tooltipText = configuredProviders.map((p) => PROVIDER_DISPLAY_NAMES[p]).join(", ");

  return (
    <div className="text-muted-foreground flex items-center justify-center gap-2 py-1.5 text-sm">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="border-border/50 hover:border-border inline-flex items-center gap-1.5 rounded border px-2 py-1 text-sm transition-colors">
            <Check className="text-success h-3.5 w-3.5" />
            <span className="flex items-center gap-1">
              {configuredProviders.map((provider) =>
                hasProviderIcon(provider) ? (
                  <ProviderIcon key={provider} provider={provider} />
                ) : (
                  <span key={provider} className="text-muted-foreground text-xs font-medium">
                    {PROVIDER_DISPLAY_NAMES[provider]}
                  </span>
                )
              )}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipText}</TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={handleOpenProviders}
        className="text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
      >
        <Settings className="h-3 w-3" />
        <span>Providers</span>
      </button>
    </div>
  );
}
