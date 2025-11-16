import type { Runtime } from "@/node/runtime/Runtime";

/**
 * Check if a path exists using runtime.stat()
 * @param runtime Runtime instance to use
 * @param path Path to check
 * @param abortSignal Optional abort signal to cancel the operation
 * @returns True if path exists, false otherwise
 */
export async function fileExists(
  runtime: Runtime,
  path: string,
  abortSignal?: AbortSignal
): Promise<boolean> {
  try {
    await runtime.stat(path, abortSignal);
    return true;
  } catch {
    return false;
  }
}
