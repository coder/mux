import { getMuxHome, migrateLegacyMuxHome } from "@/common/constants/paths";
import { ServerLockfile } from "@/node/services/serverLockfile";

export interface ServerDiscovery {
  baseUrl: string;
  authToken: string | undefined;
}

function normalizeAuthToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export interface DiscoverServerOptions {
  /** Explicit server URL override (highest priority). */
  baseUrl?: string;
  /** Explicit auth token override (highest priority). */
  authToken?: string;
  /**
   * Optional fallback base URL if discovery fails.
   * Used by `mux api` for backward compatibility.
   */
  fallbackBaseUrl?: string;
}

export async function discoverServer(options?: DiscoverServerOptions): Promise<ServerDiscovery> {
  migrateLegacyMuxHome();

  const explicitBaseUrl = options?.baseUrl?.trim();
  const explicitAuthToken = normalizeAuthToken(options?.authToken);
  if (explicitBaseUrl) {
    return {
      baseUrl: explicitBaseUrl,
      authToken: normalizeAuthToken(explicitAuthToken ?? process.env.MUX_SERVER_AUTH_TOKEN),
    };
  }

  const envBaseUrl = process.env.MUX_SERVER_URL?.trim();
  if (envBaseUrl) {
    return {
      baseUrl: envBaseUrl,
      authToken: normalizeAuthToken(explicitAuthToken ?? process.env.MUX_SERVER_AUTH_TOKEN),
    };
  }

  try {
    const lockfile = new ServerLockfile(getMuxHome());
    const data = await lockfile.read();
    if (data) {
      return {
        baseUrl: data.baseUrl,
        authToken: normalizeAuthToken(
          explicitAuthToken ?? process.env.MUX_SERVER_AUTH_TOKEN ?? data.token
        ),
      };
    }
  } catch {
    // Ignore lockfile errors
  }

  const fallbackBaseUrl = options?.fallbackBaseUrl?.trim();
  if (fallbackBaseUrl) {
    return {
      baseUrl: fallbackBaseUrl,
      authToken: normalizeAuthToken(explicitAuthToken ?? process.env.MUX_SERVER_AUTH_TOKEN),
    };
  }

  throw new Error(
    "No running mux API server found. Start mux desktop (API server enabled) or run `mux server`. " +
      "You can also set MUX_SERVER_URL / MUX_SERVER_AUTH_TOKEN."
  );
}
