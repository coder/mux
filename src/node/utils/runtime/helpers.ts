import type { Runtime, ExecOptions } from "@/node/runtime/Runtime";
import { PlatformPaths } from "../paths";

/**
 * Convenience helpers for working with streaming Runtime APIs.
 * These provide simple string-based APIs on top of the low-level streaming primitives.
 */

/**
 * Extract project name from a project path
 * Works for both local paths and remote paths
 */
export function getProjectName(projectPath: string): string {
  return PlatformPaths.getProjectName(projectPath);
}

/**
 * Result from executing a command with buffered output
 */
export interface ExecResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code (0 = success) */
  exitCode: number;
  /** Wall clock duration in milliseconds */
  duration: number;
}

/**
 * Execute a command and buffer all output into strings
 */
export async function execBuffered(
  runtime: Runtime,
  command: string,
  options: ExecOptions & { stdin?: string }
): Promise<ExecResult> {
  const stream = await runtime.exec(command, options);

  // Write stdin if provided
  if (options.stdin !== undefined) {
    const writer = stream.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    } catch (err) {
      writer.releaseLock();
      throw err;
    }
  } else {
    // Close stdin immediately if no input
    await stream.stdin.close();
  }

  // Read stdout and stderr concurrently
  const [stdout, stderr, exitCode, duration] = await Promise.all([
    streamToString(stream.stdout),
    streamToString(stream.stderr),
    stream.exitCode,
    stream.duration,
  ]);

  return { stdout, stderr, exitCode, duration };
}

/**
 * Read file contents as a UTF-8 string
 */
export async function readFileString(
  runtime: Runtime,
  path: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const stream = runtime.readFile(path, abortSignal);
  return streamToString(stream);
}

/**
 * Write string contents to a file atomically
 */
export async function writeFileString(
  runtime: Runtime,
  path: string,
  content: string,
  abortSignal?: AbortSignal
): Promise<void> {
  const stream = runtime.writeFile(path, abortSignal);
  const writer = stream.getWriter();
  try {
    await writer.write(new TextEncoder().encode(content));
    await writer.close();
  } catch (err) {
    writer.releaseLock();
    throw err;
  }
}

/**
 * Convert a ReadableStream<Uint8Array> to a UTF-8 string
 */
async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    // Final flush
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}
