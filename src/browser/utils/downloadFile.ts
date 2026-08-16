/**
 * Shared blob-download helper for surfaces that offer "Download" buttons
 * (image lightbox, attachment cards, debug snapshots).
 *
 * iOS home-screen web apps have no download manager: clicking an anchor with
 * a `download` attribute silently aborts (WebKit limitation), so we present
 * the native share sheet instead, where "Save Image" / "Save to Files" is
 * available.
 */

/**
 * `navigator.standalone` exists only on iOS WebKit and is true only when
 * launched from a Home Screen icon, so this never matches desktop PWAs or
 * Android, where anchor downloads work.
 */
function isIosStandaloneWebApp(): boolean {
  return (navigator as Navigator & { standalone?: unknown }).standalone === true;
}

/** Returns false when this environment cannot share the file, so callers can fall back. */
function shareFileViaShareSheet(file: File): boolean {
  if (typeof navigator.share !== "function" || navigator.canShare?.({ files: [file] }) !== true) {
    return false;
  }
  navigator.share({ files: [file] }).catch((err: unknown) => {
    // AbortError means the user dismissed the share sheet.
    if (err instanceof DOMException && err.name === "AbortError") return;
    console.error("Failed to share file:", err);
  });
  return true;
}

/** Trigger a download of a blob, using the share sheet on iOS home-screen web apps. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (
    isIosStandaloneWebApp() &&
    shareFileViaShareSheet(new File([blob], filename, { type: blob.type }))
  ) {
    return;
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Delay revocation so the browser can start the download first.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
