/**
 * Shared blob-download helper. iOS home-screen web apps have no download
 * manager: clicking an anchor with a `download` attribute silently aborts
 * (WebKit limitation), so downloads are offered through the native share
 * sheet ("Save Image" / "Save to Files") there.
 */

/**
 * `navigator.standalone` exists only on iOS WebKit and is true only when
 * launched from a Home Screen icon, so this never matches desktop PWAs or
 * Android, where anchor downloads work.
 */
export function isIosStandaloneWebApp(): boolean {
  return (navigator as Navigator & { standalone?: unknown }).standalone === true;
}

function canShareFile(file: File): boolean {
  return typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true;
}

/** Trigger a plain anchor download. Unusable in iOS standalone mode. */
export function downloadViaAnchor(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Trigger a download of a blob, using the share sheet on iOS home-screen web
 * apps. Runs synchronously up to the share-sheet call, so invoking it inside
 * a click handler keeps the share within the gesture's transient activation.
 *
 * Resolves false when the file was not delivered: the share sheet was blocked
 * (WebKit rejects with NotAllowedError once transient activation expires,
 * e.g. after a slow fetch), or iOS standalone mode cannot share this file at
 * all (anchor downloads silently abort there, so there is no fallback).
 * Callers that fetch bytes asynchronously can cache them and retry within a
 * fresh user gesture (see createDownloadRetryCache).
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<boolean> {
  if (isIosStandaloneWebApp()) {
    const file = new File([blob], filename, { type: blob.type });
    if (!canShareFile(file)) {
      console.error(`iOS home-screen web app cannot share or download ${blob.type} files.`);
      return false;
    }
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      // AbortError means the user dismissed the share sheet.
      if (err instanceof DOMException && err.name === "AbortError") return true;
      console.error("Failed to share file:", err);
      return false;
    }
    return true;
  }

  const objectUrl = URL.createObjectURL(blob);
  downloadViaAnchor(objectUrl, filename);
  // Delay revocation so the browser can start the download first.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  return true;
}

interface FetchedFile {
  blob: Blob;
  filename: string;
}

/**
 * Download coordinator for flows that fetch a file's bytes asynchronously
 * after the user gesture. If the fetch outlives iOS's transient-activation
 * window, the share sheet is blocked; the fetched bytes are cached so the
 * user's retry tap shares synchronously within its own activation window
 * instead of repeating the fetch and failing again.
 */
export function createDownloadRetryCache() {
  const cache = new Map<string, FetchedFile>();
  return {
    async download(key: string, fetchFile: () => Promise<FetchedFile | null>): Promise<void> {
      const cached = cache.get(key);
      if (cached) {
        if (await downloadBlob(cached.blob, cached.filename)) {
          cache.delete(key);
        }
        return;
      }
      const fetched = await fetchFile();
      if (fetched && !(await downloadBlob(fetched.blob, fetched.filename))) {
        cache.set(key, fetched);
      }
    },
  };
}
