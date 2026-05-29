export function isProviderDisabledInConfig(config: { enabled?: unknown }): boolean {
  return config.enabled === false || config.enabled === "false";
}
