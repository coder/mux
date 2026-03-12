import type { APIClient } from "@/browser/contexts/API";
import { getStoredAuthToken } from "@/browser/components/AuthTokenModal/AuthTokenModal";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import type { EventSoundSettings } from "@/common/config/schemas/appConfigOnDisk";
import type { EventSoundKey } from "@/common/config/eventSoundTypes";

function getServerAuthToken(): string | null {
  const urlToken = new URLSearchParams(window.location.search).get("token")?.trim();
  return urlToken?.length ? urlToken : getStoredAuthToken();
}

function toManagedPlaybackPath(baseUrl: string, assetId: string, authToken: string | null): string {
  const playbackUrl = new URL(`assets/event-sounds/${encodeURIComponent(assetId)}`, `${baseUrl}/`);

  // <audio> cannot attach Authorization headers, so pass the server token as
  // a query param when token-auth is in use.
  if (authToken) {
    playbackUrl.searchParams.set("token", authToken);
  }

  return playbackUrl.toString();
}

function toBrowserManagedPlaybackPath(assetId: string): string {
  // Browser mode can run behind a path-based app proxy (for example Coder),
  // so resolve against the backend base URL instead of assuming "/".
  return toManagedPlaybackPath(getBrowserBackendBaseUrl(), assetId, getServerAuthToken());
}

async function toDesktopManagedPlaybackPath(
  assetId: string,
  apiClient: APIClient | null | undefined
): Promise<string | null> {
  if (!apiClient?.server?.getApiServerStatus) {
    return null;
  }

  try {
    const apiServerStatus = await apiClient.server.getApiServerStatus();
    if (!apiServerStatus.running || !apiServerStatus.baseUrl) {
      return null;
    }

    return toManagedPlaybackPath(apiServerStatus.baseUrl, assetId, apiServerStatus.token);
  } catch {
    return null;
  }
}

function playAudioFromPath(path: string, eventKey: EventSoundKey): void {
  const audio = new Audio(path);
  void audio.play().catch((error) => {
    console.debug("Event sound playback failed", {
      eventKey,
      error: String(error),
    });
  });
}

/**
 * Attempt to play the configured sound for the given event key.
 * Fails silently with debug logging if no sound is configured or playback fails.
 */
export function playEventSound(
  eventSoundSettings: EventSoundSettings | undefined,
  eventKey: EventSoundKey,
  apiClient?: APIClient | null
): void {
  if (!eventSoundSettings) {
    return;
  }

  const config = eventSoundSettings[eventKey];
  if (!config?.enabled || config.source?.kind !== "managed") {
    return;
  }

  if (!window.api) {
    playAudioFromPath(toBrowserManagedPlaybackPath(config.source.assetId), eventKey);
    return;
  }

  void toDesktopManagedPlaybackPath(config.source.assetId, apiClient).then((playbackPath) => {
    if (!playbackPath) {
      return;
    }

    playAudioFromPath(playbackPath, eventKey);
  });
}
