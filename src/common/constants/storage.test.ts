import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyWorkspaceStorage,
  deleteWorkspaceStorage,
  getInputAttachmentsKey,
} from "@/common/constants/storage";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    const keys = Array.from(this.map.keys());
    return keys[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe("storage workspace-scoped keys", () => {
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    // The helpers in src/common/constants/storage.ts rely on global localStorage.
    // In tests we install a minimal in-memory implementation.
    originalLocalStorage = globalThis.localStorage;
    globalThis.localStorage = new MemoryStorage();
  });

  afterEach(() => {
    if (originalLocalStorage) {
      globalThis.localStorage = originalLocalStorage;
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  test("getInputAttachmentsKey formats key", () => {
    expect(getInputAttachmentsKey("ws-123")).toBe("inputAttachments:ws-123");
  });

  test("copyWorkspaceStorage copies inputAttachments key", () => {
    const source = "ws-source";
    const dest = "ws-dest";

    const sourceKey = getInputAttachmentsKey(source);
    const destKey = getInputAttachmentsKey(dest);

    const value = JSON.stringify([
      { id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
    ]);
    localStorage.setItem(sourceKey, value);

    copyWorkspaceStorage(source, dest);

    expect(localStorage.getItem(destKey)).toBe(value);
  });

  test("deleteWorkspaceStorage removes inputAttachments key", () => {
    const workspaceId = "ws-delete";
    const key = getInputAttachmentsKey(workspaceId);

    localStorage.setItem(key, "value");
    deleteWorkspaceStorage(workspaceId);

    expect(localStorage.getItem(key)).toBeNull();
  });
});
