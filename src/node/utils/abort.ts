/**
 * AbortSignal helpers.
 *
 * We frequently need to “bridge” an external AbortSignal into an internal AbortController
 * (e.g. per-stream cancellation, startup cancellation).
 *
 * The two common footguns this helper avoids:
 * - Missing an abort that happened before listener attachment.
 * - Leaving long-lived listeners around when the bridged operation completes.
 */

/**
 * Link an external AbortSignal into an AbortController.
 *
 * Returns a cleanup function that removes the event listener (no-op if none was added).
 */
export function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  const noop = () => undefined;

  if (!source) {
    return noop;
  }

  if (source.aborted) {
    target.abort();
    return noop;
  }

  const onAbort = () => target.abort();
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}
