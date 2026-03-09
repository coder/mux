import type { EventSoundSettings } from "@/common/config/schemas/appConfigOnDisk";
import type { EventSoundKey } from "@/common/config/eventSoundTypes";

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:\//;

function toFileUrlFromAbsolutePath(normalizedPath: string): string {
  const fileUrl = new URL("file:///");
  fileUrl.pathname = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  return fileUrl.toString();
}

function toFileUrlFromUncPath(filePath: string): string {
  const normalizedUncPath = filePath.replace(/\\/g, "/").replace(/^\/\/+/, "");
  const [host, ...pathParts] = normalizedUncPath.split("/");
  if (!host) {
    return toFileUrlFromAbsolutePath(`/${normalizedUncPath}`);
  }

  const fileUrl = new URL(`file://${host}`);
  fileUrl.pathname = `/${pathParts.join("/")}`;
  return fileUrl.toString();
}

function toAudioSource(filePath: string): string {
  if (filePath.startsWith("\\\\") || filePath.startsWith("//")) {
    return toFileUrlFromUncPath(filePath);
  }

  const normalizedPath = filePath.replace(/\\/g, "/");
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedPath)) {
    return toFileUrlFromAbsolutePath(normalizedPath);
  }

  if (URI_SCHEME_RE.test(filePath)) {
    return filePath;
  }

  if (normalizedPath.startsWith("/")) {
    return toFileUrlFromAbsolutePath(normalizedPath);
  }

  return normalizedPath;
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
  if (!config?.enabled || !config.filePath) {
    return;
  }

  const audio = new Audio(toAudioSource(config.filePath));
  void audio.play().catch((error) => {
    console.debug("Event sound playback failed", {
      eventKey,
      error: String(error),
    });
  });
}
