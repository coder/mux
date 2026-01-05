import { useProviderOptionsContext } from "@/browser/contexts/ProviderOptionsContext";

export function useProviderOptions() {
  const context = useProviderOptionsContext();
  return {
    options: context.options,
    setAnthropicOptions: context.setAnthropicOptions,
    setGoogleOptions: context.setGoogleOptions,
  };
}
