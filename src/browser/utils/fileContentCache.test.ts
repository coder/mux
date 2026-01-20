/**
 * Tests for fileContentCache - LRU cache with TTL expiration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  getCachedFileContent,
  setCachedFileContent,
  removeCachedFileContent,
  cacheToResult,
  CACHE_CONFIG,
  type CachedFileContent,
} from "./fileContentCache";
import type { FileContentsResult } from "./fileExplorer";

describe("fileContentCache", () => {
  // Store original config values
  const originalMaxEntries = CACHE_CONFIG.MAX_ENTRIES;
  const originalTtl = CACHE_CONFIG.TTL_MS;

  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
    // Reset config to defaults
    CACHE_CONFIG.MAX_ENTRIES = originalMaxEntries;
    CACHE_CONFIG.TTL_MS = originalTtl;
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  describe("basic operations", () => {
    test("returns null for non-existent entry", () => {
      expect(getCachedFileContent("ws1", "file.txt")).toBeNull();
    });

    test("stores and retrieves text file content", () => {
      const data: FileContentsResult = { type: "text", content: "hello world", size: 11 };
      setCachedFileContent("ws1", "file.txt", data, null);

      const cached = getCachedFileContent("ws1", "file.txt");
      expect(cached).not.toBeNull();
      expect(cached!.type).toBe("text");
      const result = cacheToResult(cached!);
      expect(result.type).toBe("text");
      if (result.type === "text") expect(result.content).toBe("hello world");
      expect(cached!.size).toBe(11);
    });

    test("handles Unicode text content", () => {
      const content = "Hello 世界! 🚀 émojis and ñ";
      const data: FileContentsResult = { type: "text", content, size: content.length };
      setCachedFileContent("ws1", "unicode.txt", data, null);

      const cached = getCachedFileContent("ws1", "unicode.txt");
      expect(cached).not.toBeNull();
      const result = cacheToResult(cached!);
      expect(result.type).toBe("text");
      if (result.type === "text") expect(result.content).toBe(content);
    });

    test("stores and retrieves image file content", () => {
      const data: FileContentsResult = {
        type: "image",
        base64: "iVBORw0KGgo=",
        mimeType: "image/png",
        size: 1024,
      };
      setCachedFileContent("ws1", "image.png", data, null);

      const cached = getCachedFileContent("ws1", "image.png");
      expect(cached).not.toBeNull();
      expect(cached!.type).toBe("image");
      expect(cached!.base64).toBe("iVBORw0KGgo=");
      expect(cached!.mimeType).toBe("image/png");
    });

    test("does not cache error results", () => {
      const data: FileContentsResult = { type: "error", message: "File not found" };
      setCachedFileContent("ws1", "missing.txt", data, null);

      expect(getCachedFileContent("ws1", "missing.txt")).toBeNull();
    });

    test("stores diff alongside file content", () => {
      const data: FileContentsResult = { type: "text", content: "modified", size: 8 };
      setCachedFileContent("ws1", "file.txt", data, "+modified\n-original");

      const cached = getCachedFileContent("ws1", "file.txt");
      expect(cached!.diff).toBe("+modified\n-original");
    });

    test("separates entries by workspace", () => {
      const data1: FileContentsResult = { type: "text", content: "ws1 content", size: 11 };
      const data2: FileContentsResult = { type: "text", content: "ws2 content", size: 11 };

      setCachedFileContent("ws1", "file.txt", data1, null);
      setCachedFileContent("ws2", "file.txt", data2, null);

      const r1 = cacheToResult(getCachedFileContent("ws1", "file.txt")!);
      const r2 = cacheToResult(getCachedFileContent("ws2", "file.txt")!);
      expect(r1.type === "text" && r1.content).toBe("ws1 content");
      expect(r2.type === "text" && r2.content).toBe("ws2 content");
    });
  });

  describe("TTL expiration", () => {
    test("returns null and removes entry when TTL expired", () => {
      // Set a very short TTL for testing
      CACHE_CONFIG.TTL_MS = 100;

      const data: FileContentsResult = { type: "text", content: "will expire", size: 11 };
      setCachedFileContent("ws1", "file.txt", data, null);

      // Should be available immediately
      expect(getCachedFileContent("ws1", "file.txt")).not.toBeNull();

      // Manually expire by modifying cachedAt in storage
      const key = "explorer:file:ws1:file.txt";
      const stored = JSON.parse(globalThis.window.localStorage.getItem(key)!) as CachedFileContent;
      stored.cachedAt = Date.now() - 200; // 200ms ago, past TTL
      globalThis.window.localStorage.setItem(key, JSON.stringify(stored));

      // Should return null and clean up
      expect(getCachedFileContent("ws1", "file.txt")).toBeNull();

      // Entry should be removed from storage
      expect(globalThis.window.localStorage.getItem(key)).toBeNull();
    });

    test("removes expired entry from index", () => {
      CACHE_CONFIG.TTL_MS = 100;

      const data: FileContentsResult = { type: "text", content: "test", size: 4 };
      setCachedFileContent("ws1", "file.txt", data, null);

      // Expire the entry
      const key = "explorer:file:ws1:file.txt";
      const stored = JSON.parse(globalThis.window.localStorage.getItem(key)!) as CachedFileContent;
      stored.cachedAt = Date.now() - 200;
      globalThis.window.localStorage.setItem(key, JSON.stringify(stored));

      // Trigger expiration check
      getCachedFileContent("ws1", "file.txt");

      // Check index is updated
      const index = JSON.parse(
        globalThis.window.localStorage.getItem("explorer:fileIndex") ?? "[]"
      ) as string[];
      expect(index).not.toContain(key);
    });
  });

  describe("LRU eviction", () => {
    test("evicts oldest entries when exceeding max", () => {
      // Use a small limit for testing
      CACHE_CONFIG.MAX_ENTRIES = 3;

      // Add 3 entries
      for (let i = 1; i <= 3; i++) {
        const data: FileContentsResult = { type: "text", content: `file${i}`, size: 5 };
        setCachedFileContent("ws1", `file${i}.txt`, data, null);
      }

      // All 3 should exist
      expect(getCachedFileContent("ws1", "file1.txt")).not.toBeNull();
      expect(getCachedFileContent("ws1", "file2.txt")).not.toBeNull();
      expect(getCachedFileContent("ws1", "file3.txt")).not.toBeNull();

      // Add a 4th entry - should evict file1 (oldest)
      const data4: FileContentsResult = { type: "text", content: "file4", size: 5 };
      setCachedFileContent("ws1", "file4.txt", data4, null);

      expect(getCachedFileContent("ws1", "file1.txt")).toBeNull();
      expect(getCachedFileContent("ws1", "file2.txt")).not.toBeNull();
      expect(getCachedFileContent("ws1", "file3.txt")).not.toBeNull();
      expect(getCachedFileContent("ws1", "file4.txt")).not.toBeNull();
    });

    test("re-writing an entry moves it to end of LRU queue", () => {
      CACHE_CONFIG.MAX_ENTRIES = 3;

      // Add 3 entries
      for (let i = 1; i <= 3; i++) {
        const data: FileContentsResult = { type: "text", content: `file${i}`, size: 5 };
        setCachedFileContent("ws1", `file${i}.txt`, data, null);
      }

      // Re-write file1 (simulates background refresh) to move it to end
      const data1: FileContentsResult = { type: "text", content: "file1", size: 5 };
      setCachedFileContent("ws1", "file1.txt", data1, null);

      // Add file4 - should evict file2 (now oldest since file1 was refreshed)
      const data4: FileContentsResult = { type: "text", content: "file4", size: 5 };
      setCachedFileContent("ws1", "file4.txt", data4, null);

      expect(getCachedFileContent("ws1", "file1.txt")).not.toBeNull();
      expect(getCachedFileContent("ws1", "file2.txt")).toBeNull(); // evicted
      expect(getCachedFileContent("ws1", "file3.txt")).not.toBeNull();
      expect(getCachedFileContent("ws1", "file4.txt")).not.toBeNull();
    });

    test("evicts multiple entries when adding many at once", () => {
      CACHE_CONFIG.MAX_ENTRIES = 3;

      // Add 5 entries - should keep only last 3
      for (let i = 1; i <= 5; i++) {
        const data: FileContentsResult = { type: "text", content: `file${i}`, size: 5 };
        setCachedFileContent("ws1", `file${i}.txt`, data, null);
      }

      expect(getCachedFileContent("ws1", "file1.txt")).toBeNull();
      expect(getCachedFileContent("ws1", "file2.txt")).toBeNull();
      expect(getCachedFileContent("ws1", "file3.txt")).not.toBeNull();
      expect(getCachedFileContent("ws1", "file4.txt")).not.toBeNull();
      expect(getCachedFileContent("ws1", "file5.txt")).not.toBeNull();
    });

    test("removes evicted entries from localStorage", () => {
      CACHE_CONFIG.MAX_ENTRIES = 2;

      const data1: FileContentsResult = { type: "text", content: "file1", size: 5 };
      const data2: FileContentsResult = { type: "text", content: "file2", size: 5 };
      const data3: FileContentsResult = { type: "text", content: "file3", size: 5 };

      setCachedFileContent("ws1", "file1.txt", data1, null);
      setCachedFileContent("ws1", "file2.txt", data2, null);
      setCachedFileContent("ws1", "file3.txt", data3, null);

      // file1 should be evicted and removed from localStorage
      expect(globalThis.window.localStorage.getItem("explorer:file:ws1:file1.txt")).toBeNull();
      expect(globalThis.window.localStorage.getItem("explorer:file:ws1:file2.txt")).not.toBeNull();
      expect(globalThis.window.localStorage.getItem("explorer:file:ws1:file3.txt")).not.toBeNull();
    });
  });

  describe("removeCachedFileContent", () => {
    test("removes entry from cache", () => {
      const data: FileContentsResult = { type: "text", content: "hello", size: 5 };
      setCachedFileContent("ws1", "file.txt", data, null);

      expect(getCachedFileContent("ws1", "file.txt")).not.toBeNull();

      removeCachedFileContent("ws1", "file.txt");

      expect(getCachedFileContent("ws1", "file.txt")).toBeNull();
    });

    test("removes entry from index", () => {
      const data: FileContentsResult = { type: "text", content: "hello", size: 5 };
      setCachedFileContent("ws1", "file.txt", data, null);

      removeCachedFileContent("ws1", "file.txt");

      const index = JSON.parse(
        globalThis.window.localStorage.getItem("explorer:fileIndex") ?? "[]"
      ) as string[];
      expect(index).not.toContain("explorer:file:ws1:file.txt");
    });

    test("handles removing non-existent entry gracefully", () => {
      // Should not throw
      expect(() => removeCachedFileContent("ws1", "nonexistent.txt")).not.toThrow();
    });
  });

  describe("cacheToResult", () => {
    test("converts cached text content to FileContentsResult", () => {
      const data: FileContentsResult = { type: "text", content: "hello world", size: 11 };
      setCachedFileContent("ws1", "file.txt", data, null);

      const cached = getCachedFileContent("ws1", "file.txt")!;
      const result = cacheToResult(cached);

      expect(result.type).toBe("text");
      expect(result).toHaveProperty("content", "hello world");
      expect(result).toHaveProperty("size", 11);
    });

    test("converts cached image content to FileContentsResult", () => {
      const data: FileContentsResult = {
        type: "image",
        base64: "iVBORw0KGgo=",
        mimeType: "image/png",
        size: 1024,
      };
      setCachedFileContent("ws1", "image.png", data, null);

      const cached = getCachedFileContent("ws1", "image.png")!;
      const result = cacheToResult(cached);

      expect(result.type).toBe("image");
      expect(result).toHaveProperty("base64", "iVBORw0KGgo=");
      expect(result).toHaveProperty("mimeType", "image/png");
      expect(result).toHaveProperty("size", 1024);
    });

    test("uses default mimeType when missing", () => {
      // Manually create a cached entry without mimeType
      const cached = {
        type: "image" as const,
        base64: "abc123",
        size: 100,
        cachedAt: Date.now(),
      };
      globalThis.window.localStorage.setItem("explorer:file:ws1:test.bin", JSON.stringify(cached));

      const retrieved = getCachedFileContent("ws1", "test.bin")!;
      const result = cacheToResult(retrieved);

      expect(result).toHaveProperty("mimeType", "application/octet-stream");
    });
  });
});
