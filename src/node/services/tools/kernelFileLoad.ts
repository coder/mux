/**
 * Host-side bulk file ingestion for the RLM kernel (mux.load, r12).
 *
 * mux.file_read caps at ~16KB/1000 lines per call, so bulk reads paginate
 * into N model-visible records — exactly the context leak RLM exists to
 * close. mux.load reads the WHOLE file host-side and hands the content
 * straight to the guest `vars` namespace; the guest return value and the
 * model-visible record only ever carry {key, bytes, lines, preview}.
 */

import type { Runtime } from "@/node/runtime/Runtime";
import {
  StreamByteCeilingExceededError,
  streamToStringWithByteCeiling,
} from "@/node/runtime/streamUtils";
import { MAX_FILE_SIZE, resolvePathWithinCwd, validateFileSize } from "./fileCommon";
import { KERNEL_LOAD_PREVIEW_CHARS } from "@/constants/kernelOutput";

/** Full content + bounded model-visible summary of one loaded file. */
export interface KernelLoadedFile {
  /** Full file content — guest-only (destined for vars[key]); never model-visible. */
  content: string;
  bytes: number;
  lines: number;
  /** Bounded head of the content. */
  preview: string;
}

/** Host closure resolving + reading a file with the workspace's cwd/runtime. */
export type KernelFileLoader = (args: {
  path: string;
  /**
   * Kernel cancellation must reach the underlying I/O: a stalled remote read
   * would otherwise ride RemoteRuntime's 300s `cat` timeout, keeping the
   * persistent-mount lease occupied long past the execution deadline or a
   * workspace removal.
   */
  abortSignal?: AbortSignal;
}) => Promise<KernelLoadedFile>;

/**
 * Build the loader from the same cwd/runtime pair the file tools use, so
 * absolute/relative path resolution is consistent with mux.file_read.
 * Errors are thrown (not returned) so the tool bridge surfaces them as
 * catchable guest errors recorded by the compact call record.
 */
export function createKernelFileLoader(config: {
  cwd: string;
  runtime: Runtime;
}): KernelFileLoader {
  return async ({ path, abortSignal }) => {
    const { resolvedPath } = resolvePathWithinCwd(path, config.cwd, config.runtime);
    // stat throws a RuntimeError with a clear message for missing paths.
    const stat = await config.runtime.stat(resolvedPath, abortSignal);
    if (stat.isDirectory) {
      throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
    }
    // Keep file_read's file-size ceiling (per-operation sanity bound). The
    // 16KB/1000-line PAGINATION caps do not apply — that is the point of
    // load — but loads land in `vars`, which is snapshotted after every call
    // and subject to the 4MB retention policy, so a single load must stay
    // well under that budget.
    const sizeValidation = validateFileSize(stat);
    if (sizeValidation) {
      throw new Error(sizeValidation.error);
    }
    // The stat-based check alone is insufficient: device files report size 0
    // (/dev/zero streams forever) and a concurrently growing file races
    // stat→read — either would buffer unboundedly in the Electron process,
    // and local readFile ignores the abort signal. Enforce the same ceiling
    // WHILE consuming the stream, cancelling as soon as it is exceeded.
    let content: string;
    try {
      content = await streamToStringWithByteCeiling(
        config.runtime.readFile(resolvedPath, abortSignal),
        MAX_FILE_SIZE
      );
    } catch (error) {
      if (error instanceof StreamByteCeilingExceededError) {
        throw new Error(
          `File grew past or misreported its size: read exceeded ${MAX_FILE_SIZE} bytes for ${resolvedPath}`
        );
      }
      throw error;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    // Count newline-delimited records, not split segments: a conventional
    // newline-terminated file yields a trailing empty segment that would
    // report one extra line — and this summary is model-visible, so an
    // exact-count task would come out wrong without reparsing the value.
    const segments = content.split("\n");
    if (segments.length > 1 && segments[segments.length - 1] === "") {
      segments.pop();
    }
    const lines = content === "" ? 0 : segments.length;
    const preview = content.slice(0, KERNEL_LOAD_PREVIEW_CHARS);
    return { content, bytes, lines, preview };
  };
}
