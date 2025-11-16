/**
 * MutexMap - Generic mutex utility for serializing operations per key
 *
 * Prevents race conditions when multiple concurrent operations need to
 * modify the same resource (file, data structure, etc.) identified by a key.
 *
 * Example usage:
 * ```typescript
 * const fileLocks = new MutexMap<string>();
 *
 * // Serialize writes to the same file
 * await fileLocks.withLock("file.txt", async () => {
 *   await fs.writeFile("file.txt", data);
 * });
 * ```
 */
export class MutexMap<K> {
  private locks = new Map<K, Promise<void>>();

  /**
   * Execute an operation with exclusive access per key
   * Operations for the same key are serialized (run one at a time)
   * Operations for different keys can run concurrently
   */
  async withLock<T>(key: K, operation: () => Promise<T>): Promise<T> {
    // Wait for any existing operation on this key to complete
    const existingLock = this.locks.get(key);
    if (existingLock) {
      await existingLock;
    }

    // Create a new lock for this operation
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.locks.set(key, lockPromise);

    try {
      // Execute the operation
      return await operation();
    } finally {
      // Release the lock
      releaseLock!();
      // Clean up if this is the current lock
      if (this.locks.get(key) === lockPromise) {
        this.locks.delete(key);
      }
    }
  }
}
