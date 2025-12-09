/**
 * Jest setup file to ensure Symbol.dispose is available in test environment.
 * Required for explicit resource management (using declarations) to work.
 */

import assert from "assert";
import "disposablestack/auto";

assert.equal(typeof Symbol.dispose, "symbol");
// Use fast approximate token counting in Jest to avoid 10s WASM cold starts
// Individual tests can override with MUX_FORCE_REAL_TOKENIZER=1
if (process.env.MUX_FORCE_REAL_TOKENIZER !== "1") {
  process.env.MUX_APPROX_TOKENIZER ??= "1";
}

assert.equal(typeof Symbol.asyncDispose, "symbol");

// Polyfill File for undici in jest environment
// undici expects File to be available globally but jest doesn't provide it
if (typeof globalThis.File === "undefined") {
  (globalThis as any).File = class File extends Blob {
    constructor(bits: BlobPart[], name: string, options?: FilePropertyBag) {
      super(bits, options);
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
    name: string;
    lastModified: number;
  };
}

// Preload tokenizer and AI SDK modules for integration tests
// This eliminates ~10s initialization delay on first use
if (process.env.TEST_INTEGRATION === "1") {
  // Store promise globally to ensure it blocks subsequent test execution
  (globalThis as any).__muxPreloadPromise = (async () => {
    const { preloadTestModules } = await import("./ipc/setup");
    await preloadTestModules();
  })();

  // Add a global beforeAll to block until preload completes
  beforeAll(async () => {
    await (globalThis as any).__muxPreloadPromise;
  }, 30000); // 30s timeout for preload
}
