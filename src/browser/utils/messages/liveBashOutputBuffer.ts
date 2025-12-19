export interface LiveBashOutputView {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface LiveBashOutputSegment {
  isError: boolean;
  text: string;
  bytes: number;
}

/**
 * Internal representation used by WorkspaceStore.
 *
 * We retain per-chunk segments so we can drop the oldest output first while
 * still rendering stdout and stderr separately.
 */
export interface LiveBashOutputInternal extends LiveBashOutputView {
  segments: LiveBashOutputSegment[];
  totalBytes: number;
}

function getUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function appendLiveBashOutputChunk(
  prev: LiveBashOutputInternal | undefined,
  chunk: { text: string; isError: boolean },
  maxBytes: number
): LiveBashOutputInternal {
  if (maxBytes <= 0) {
    throw new Error(`maxBytes must be > 0 (got ${maxBytes})`);
  }

  const base: LiveBashOutputInternal =
    prev ??
    ({
      stdout: "",
      stderr: "",
      truncated: false,
      segments: [],
      totalBytes: 0,
    } satisfies LiveBashOutputInternal);

  if (chunk.text.length === 0) return base;

  // Clone for purity (tests + avoids hidden mutation assumptions).
  const next: LiveBashOutputInternal = {
    stdout: base.stdout,
    stderr: base.stderr,
    truncated: base.truncated,
    segments: base.segments.slice(),
    totalBytes: base.totalBytes,
  };

  const segment: LiveBashOutputSegment = {
    isError: chunk.isError,
    text: chunk.text,
    bytes: getUtf8ByteLength(chunk.text),
  };

  next.segments.push(segment);
  next.totalBytes += segment.bytes;
  if (segment.isError) {
    next.stderr += segment.text;
  } else {
    next.stdout += segment.text;
  }

  while (next.totalBytes > maxBytes && next.segments.length > 0) {
    const removed = next.segments.shift();
    if (!removed) break;

    next.totalBytes -= removed.bytes;
    next.truncated = true;

    if (removed.isError) {
      next.stderr = next.stderr.slice(removed.text.length);
    } else {
      next.stdout = next.stdout.slice(removed.text.length);
    }
  }

  if (next.totalBytes < 0) {
    throw new Error("Invariant violation: totalBytes < 0");
  }

  return next;
}

export function toLiveBashOutputView(state: LiveBashOutputInternal): LiveBashOutputView {
  return { stdout: state.stdout, stderr: state.stderr, truncated: state.truncated };
}
