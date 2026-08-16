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
 * "blocked" is retryable within a fresh user gesture; "unshareable" is
 * permanent for the file in the current environment.
 */
export type DownloadBlobResult = "delivered" | "blocked" | "unshareable";

/**
 * Trigger a download of a blob, using the share sheet on iOS home-screen web
 * apps. Runs synchronously up to the share-sheet call, so invoking it inside
 * a click handler keeps the share within the gesture's transient activation.
 *
 * Both failure branches alert the user here, at the shared boundary, so
 * fire-and-forget callers cannot silently drop a failed download; the result
 * exists for callers that manage retries (see createDownloadRetryCache).
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<DownloadBlobResult> {
  if (isIosStandaloneWebApp()) {
    const file = new File([blob], filename, { type: blob.type });
    if (!canShareFile(file)) {
      // Anchor downloads silently abort in iOS standalone mode, so there is
      // no usable fallback for unshareable files.
      window.alert(`This file type (${blob.type || "unknown"}) can't be saved from this app.`);
      return "unshareable";
    }
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      // AbortError means the user dismissed the share sheet.
      if (err instanceof DOMException && err.name === "AbortError") return "delivered";
      // Typically NotAllowedError: WebKit blocks share() once the gesture's
      // transient activation expires (e.g. after a slow fetch).
      console.error("Failed to share file:", err);
      window.alert("Saving was interrupted. Tap the download again to save.");
      return "blocked";
    }
    return "delivered";
  }

  const objectUrl = URL.createObjectURL(blob);
  downloadViaAnchor(objectUrl, filename);
  // Delay revocation so the browser can start the download first.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  return "delivered";
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
 * instead of repeating the fetch and failing again. Only "blocked" failures
 * are cached: unshareable files can never succeed, so retaining their bytes
 * would only grow renderer memory.
 */
export function createDownloadRetryCache() {
  const cache = new Map<string, FetchedFile>();
  return {
    async download(key: string, fetchFile: () => Promise<FetchedFile | null>): Promise<void> {
      const cached = cache.get(key);
      if (cached) {
        if ((await downloadBlob(cached.blob, cached.filename)) !== "blocked") {
          cache.delete(key);
        }
        return;
      }
      const fetched = await fetchFile();
      if (fetched && (await downloadBlob(fetched.blob, fetched.filename)) === "blocked") {
        cache.set(key, fetched);
      }
    },
  };
}
