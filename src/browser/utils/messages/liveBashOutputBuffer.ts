export interface LiveBashOutputView {
  stdout: string;
  stderr: string;
  /** Combined output in emission order (stdout/stderr interleaved). */
  combined: string;
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

function normalizeNewlines(text: string): string {
  // Many CLIs print "progress" output using carriage returns so they can update a single line.
  // In our UI, that reads better as actual line breaks.
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
      combined: "",
      truncated: false,
      segments: [],
      totalBytes: 0,
    } satisfies LiveBashOutputInternal);

  const normalizedText = normalizeNewlines(chunk.text);
  if (normalizedText.length === 0) return base;

  // Clone for purity (tests + avoids hidden mutation assumptions).
  const next: LiveBashOutputInternal = {
    stdout: base.stdout,
    stderr: base.stderr,
    combined: base.combined,
    truncated: base.truncated,
    segments: base.segments.slice(),
    totalBytes: base.totalBytes,
  };

  const segment: LiveBashOutputSegment = {
    isError: chunk.isError,
    text: normalizedText,
    bytes: getUtf8ByteLength(normalizedText),
  };

  next.segments.push(segment);
  next.totalBytes += segment.bytes;
  next.combined += segment.text;
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
    next.combined = next.combined.slice(removed.text.length);

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
  return {
    stdout: state.stdout,
    stderr: state.stderr,
    combined: state.combined,
    truncated: state.truncated,
  };
}
