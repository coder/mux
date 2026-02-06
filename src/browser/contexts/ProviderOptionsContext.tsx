import React, { createContext, useContext, useRef } from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { supports1MContext } from "@/common/utils/ai/models";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

interface ProviderOptionsContextType {
  options: MuxProviderOptions;
  setAnthropicOptions: (options: MuxProviderOptions["anthropic"]) => void;
  setGoogleOptions: (options: MuxProviderOptions["google"]) => void;
  /** Check if a specific model has 1M context enabled */
  has1MContext: (modelId: string) => boolean;
  /** Toggle 1M context for a specific model */
  toggle1MContext: (modelId: string) => void;
}

const ProviderOptionsContext = createContext<ProviderOptionsContextType | undefined>(undefined);

/**
 * Migrate legacy `use1MContext: true` (global toggle) to `use1MContextModels` (per-model set).
 * When the old global boolean is true and no per-model list exists, populate with all supported models.
 * Returns the migrated options (or original if no migration needed).
 */
function migrateGlobalToPerModel(
  options: MuxProviderOptions["anthropic"]
): MuxProviderOptions["anthropic"] {
  if (
    !options?.use1MContext ||
    (options.use1MContextModels && options.use1MContextModels.length > 0)
  ) {
    return options;
  }
  // Populate with all known models that support 1M context
  const supported = Object.values(KNOWN_MODELS)
    .filter((m) => supports1MContext(m.id))
    .map((m) => m.id);
  return {
    ...options,
    use1MContext: false,
    use1MContextModels: supported,
  };
}

export function ProviderOptionsProvider({ children }: { children: React.ReactNode }) {
  const [anthropicOptions, setAnthropicOptions] = usePersistedState<
    MuxProviderOptions["anthropic"]
  >("provider_options_anthropic", {});

  // One-time migration from global boolean to per-model set
  const didMigrate = useRef(false);
  if (!didMigrate.current) {
    didMigrate.current = true;
    const migrated = migrateGlobalToPerModel(anthropicOptions);
    if (migrated !== anthropicOptions) {
      setAnthropicOptions(migrated);
    }
  }

  const [googleOptions, setGoogleOptions] = usePersistedState<MuxProviderOptions["google"]>(
    "provider_options_google",
    {}
  );

  const models1M = anthropicOptions?.use1MContextModels ?? [];

  const has1MContext = (modelId: string): boolean => models1M.includes(modelId);

  const toggle1MContext = (modelId: string): void => {
    const next = has1MContext(modelId)
      ? models1M.filter((id) => id !== modelId)
      : [...models1M, modelId];
    setAnthropicOptions({
      ...anthropicOptions,
      use1MContextModels: next,
    });
  };

  const value = {
    options: {
      anthropic: anthropicOptions,
      google: googleOptions,
    },
    setAnthropicOptions,
    setGoogleOptions,
    has1MContext,
    toggle1MContext,
  };

  return (
    <ProviderOptionsContext.Provider value={value}>{children}</ProviderOptionsContext.Provider>
  );
}

export function useProviderOptionsContext() {
  const context = useContext(ProviderOptionsContext);
  if (!context) {
    throw new Error("useProviderOptionsContext must be used within a ProviderOptionsProvider");
  }
  return context;
}
