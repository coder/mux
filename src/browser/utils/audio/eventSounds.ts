import type { EventSoundSettings } from "@/common/config/schemas/appConfigOnDisk";
import type { EventSoundKey } from "@/common/config/eventSoundTypes";

function toManagedPlaybackPath(assetId: string): string {
  return `/assets/event-sounds/${encodeURIComponent(assetId)}`;
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
