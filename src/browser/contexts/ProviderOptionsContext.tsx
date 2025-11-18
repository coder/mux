import React, { createContext, useContext } from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import type { MuxProviderOptions } from "@/common/types/providerOptions";

interface ProviderOptionsContextType {
  options: MuxProviderOptions;
  setAnthropicOptions: (options: MuxProviderOptions["anthropic"]) => void;
  setOpenAIOptions: (options: MuxProviderOptions["openai"]) => void;
  setGoogleOptions: (options: MuxProviderOptions["google"]) => void;
}

const ProviderOptionsContext = createContext<ProviderOptionsContextType | undefined>(undefined);

export function ProviderOptionsProvider({ children }: { children: React.ReactNode }) {
  const [anthropicOptions, setAnthropicOptions] = usePersistedState<
    MuxProviderOptions["anthropic"]
  >("provider_options_anthropic", {
    use1MContext: false,
  });

  const [openaiOptions, setOpenAIOptions] = usePersistedState<MuxProviderOptions["openai"]>(
    "provider_options_openai",
    {
      disableAutoTruncation: false,
    }
  );

  const [googleOptions, setGoogleOptions] = usePersistedState<MuxProviderOptions["google"]>(
    "provider_options_google",
    {
      useSearchGrounding: false,
      useUrlContext: false,
      includeThoughts: false,
    }
  );

  const value = {
    options: {
      anthropic: anthropicOptions,
      openai: openaiOptions,
      google: googleOptions,
    },
    setAnthropicOptions,
    setOpenAIOptions,
    setGoogleOptions,
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
