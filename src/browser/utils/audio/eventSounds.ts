import { getStoredAuthToken } from "@/browser/components/AuthTokenModal/AuthTokenModal";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import type { EventSoundSettings } from "@/common/config/schemas/appConfigOnDisk";
import type { EventSoundKey } from "@/common/config/eventSoundTypes";

function getServerAuthToken(): string | null {
  const urlToken = new URLSearchParams(window.location.search).get("token")?.trim();
  return urlToken?.length ? urlToken : getStoredAuthToken();
}

function toManagedPlaybackPath(assetId: string): string {
  // Browser mode can run behind a path-based app proxy (for example Coder),
  // so resolve against the backend base URL instead of assuming "/".
  const backendBaseUrl = getBrowserBackendBaseUrl();
  const playbackUrl = new URL(
    `assets/event-sounds/${encodeURIComponent(assetId)}`,
    `${backendBaseUrl}/`
  );

  // <audio> cannot attach Authorization headers, so pass the server token as
  // a query param when token-auth is in use.
  const authToken = getServerAuthToken();
  if (authToken) {
    playbackUrl.searchParams.set("token", authToken);
  }

  return playbackUrl.toString();
}

/**
 * Attempt to play the configured sound for the given event key.
 * Fails silently with debug logging if no sound is configured or playback fails.
 */
export function playEventSound(
  eventSoundSettings: EventSoundSettings | undefined,
  eventKey: EventSoundKey
): void {
  if (!eventSoundSettings) {
    return;
  }

  const config = eventSoundSettings[eventKey];
  if (!config?.enabled || config.source?.kind !== "managed") {
    return;
  }

  const audio = new Audio(toManagedPlaybackPath(config.source.assetId));
  void audio.play().catch((error) => {
    console.debug("Event sound playback failed", {
      eventKey,
      error: String(error),
    });
  });
}
