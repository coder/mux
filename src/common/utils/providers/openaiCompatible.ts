const OPENAI_COMPATIBLE_PREFIX = "openai-compatible/";

export function isOpenAICompatibleProvider(provider: string): boolean {
  return provider.startsWith(OPENAI_COMPATIBLE_PREFIX);
}

export function formatOpenAICompatibleDisplayName(provider: string): string {
  const instanceId = provider.slice(OPENAI_COMPATIBLE_PREFIX.length);
  return instanceId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
