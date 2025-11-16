import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Extract hostname from SSH runtime config.
 * Returns null if runtime is local or not configured.
 *
 * Examples:
 * - "hostname" -> "hostname"
 * - "user@hostname" -> "hostname"
 * - "user@hostname:port" -> "hostname"
 */
export function extractSshHostname(runtimeConfig?: RuntimeConfig): string | null {
  if (!runtimeConfig?.type || runtimeConfig.type !== "ssh") {
    return null;
  }

  const { host } = runtimeConfig;

  // Remove user@ prefix if present
  const withoutUser = host.includes("@") ? host.split("@")[1] : host;

  // Remove :port suffix if present (though port is usually in separate field)
  const hostname = withoutUser.split(":")[0];

  return hostname || null;
}
