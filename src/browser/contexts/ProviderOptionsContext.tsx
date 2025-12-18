import React, { createContext, useContext, useLayoutEffect } from "react";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import type { MuxProviderOptions } from "@/common/types/providerOptions";

interface ProviderOptionsContextType {
  options: MuxProviderOptions;
  setAnthropicOptions: (options: MuxProviderOptions["anthropic"]) => void;
  setOpenAIOptions: (options: MuxProviderOptions["openai"]) => void;
  setGoogleOptions: (options: MuxProviderOptions["google"]) => void;
}

const ProviderOptionsContext = createContext<ProviderOptionsContextType | undefined>(undefined);

const OPENAI_OPTIONS_KEY = "provider_options_openai";
// One-time migration key: force disableAutoTruncation to true for existing users
const OPENAI_TRUNCATION_MIGRATION_KEY = "provider_options_openai_truncation_migrated";

export function ProviderOptionsProvider({ children }: { children: React.ReactNode }) {
  const [anthropicOptions, setAnthropicOptions] = usePersistedState<
    MuxProviderOptions["anthropic"]
  >("provider_options_anthropic", {
    use1MContext: false,
  });

  const [openaiOptions, setOpenAIOptions] = usePersistedState<MuxProviderOptions["openai"]>(
    OPENAI_OPTIONS_KEY,
    { disableAutoTruncation: true }
  );

  // One-time migration: force disableAutoTruncation to true for existing users
  useLayoutEffect(() => {
    const alreadyMigrated = readPersistedState<boolean>(OPENAI_TRUNCATION_MIGRATION_KEY, false);
    if (alreadyMigrated) {
      return;
    }
    updatePersistedState(OPENAI_OPTIONS_KEY, { disableAutoTruncation: true });
    updatePersistedState(OPENAI_TRUNCATION_MIGRATION_KEY, true);
  }, []);

  const [googleOptions, setGoogleOptions] = usePersistedState<MuxProviderOptions["google"]>(
    "provider_options_google",
    {}
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
