import type { EventSoundSettings } from "@/common/config/schemas/appConfigOnDisk";
import type { EventSoundKey } from "@/common/config/eventSoundTypes";

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
  if (!config?.enabled || !config.filePath) {
    return;
  }

  const audio = new Audio(config.filePath);
  void audio.play().catch((error) => {
    console.debug("Event sound playback failed", {
      eventKey,
      error: String(error),
    });
  });
}
