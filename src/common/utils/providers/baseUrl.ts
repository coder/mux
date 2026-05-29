export function resolveConfigBaseUrl(config: {
  baseUrl?: unknown;
  baseURL?: unknown;
}): string | undefined {
  const rawBaseUrl =
    (typeof config.baseUrl === "string" ? config.baseUrl : undefined) ??
    (typeof config.baseURL === "string" ? config.baseURL : undefined);
  const trimmed = rawBaseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}
