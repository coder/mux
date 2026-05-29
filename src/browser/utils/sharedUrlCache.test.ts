import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getSharedUrl,
  getShareData,
  setShareData,
  removeShareData,
  updateShareExpiration,
} from "./sharedUrlCache";

// Mock localStorage for testing
const mockStorage = new Map<string, string>();

const mockLocalStorage: Storage = {
  getItem: (key: string) => mockStorage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    mockStorage.set(key, value);
  },
  removeItem: (key: string) => {
    mockStorage.delete(key);
  },
  clear: () => {
    mockStorage.clear();
  },
  get length() {
    return mockStorage.size;
  },
  key: (index: number) => Array.from(mockStorage.keys())[index] ?? null,
};

// Save original window to restore after tests
const originalWindow = globalThis.window;

beforeEach(() => {
  mockStorage.clear();
  // The persisted state helpers check window.localStorage and dispatch events
  globalThis.window = {
    localStorage: mockLocalStorage,
    dispatchEvent: () => true,
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    addEventListener: () => {},
  } as unknown as Window & typeof globalThis;
});

afterEach(() => {
  // Restore original window to avoid polluting other tests
  globalThis.window = originalWindow;
});

describe("sharedUrlCache", () => {
  const makeShareData = (url: string, id = "abc123", mutateKey = "key123") => ({
    url,
    id,
    mutateKey,
    expiresAt: undefined,
  });

  it("should store and retrieve share data for content", () => {
    const content = "Hello, world!";
    const data = makeShareData("https://mux.md/abc123#key");

    setShareData(content, data);
    const result = getShareData(content);
    expect(result?.url).toBe(data.url);
    expect(result?.id).toBe(data.id);
    expect(result?.mutateKey).toBe(data.mutateKey);
  });

  it("should return URL via getSharedUrl convenience function", () => {
    const content = "Hello, world!";
    const url = "https://mux.md/abc123#key";

    setShareData(content, makeShareData(url));
    expect(getSharedUrl(content)).toBe(url);
  });

  it("should return undefined for unknown content", () => {
    expect(getSharedUrl("unknown content")).toBeUndefined();
    expect(getShareData("unknown content")).toBeUndefined();
  });

  it("should overwrite existing data for same content", () => {
    const content = "Hello, world!";
    const url1 = "https://mux.md/abc123#key1";
    const url2 = "https://mux.md/def456#key2";

    setShareData(content, makeShareData(url1, "abc123"));
    setShareData(content, makeShareData(url2, "def456"));
    expect(getSharedUrl(content)).toBe(url2);
    expect(getShareData(content)?.id).toBe("def456");
  });

  it("should use different keys for different content", () => {
    const content1 = "Content A";
    const content2 = "Content B";
    const url1 = "https://mux.md/abc123#key1";
    const url2 = "https://mux.md/def456#key2";

    setShareData(content1, makeShareData(url1, "abc123"));
    setShareData(content2, makeShareData(url2, "def456"));

    expect(getSharedUrl(content1)).toBe(url1);
    expect(getSharedUrl(content2)).toBe(url2);
  });

  it("should handle content with special characters", () => {
    const content = "Hello! @#$%^&*() 你好 🎉";
    const url = "https://mux.md/abc123#key";

    setShareData(content, makeShareData(url));
    expect(getSharedUrl(content)).toBe(url);
  });

  it("should remove share data", () => {
    const content = "Hello, world!";
    setShareData(content, makeShareData("https://mux.md/abc123#key"));
    expect(getSharedUrl(content)).toBeDefined();

    removeShareData(content);
    expect(getSharedUrl(content)).toBeUndefined();
  });

  it("should update expiration", () => {
    const content = "Hello, world!";
    const futureTime = Date.now() + 1000 * 60 * 60; // 1 hour from now

    setShareData(content, makeShareData("https://mux.md/abc123#key"));
    expect(getShareData(content)?.expiresAt).toBeUndefined();

    updateShareExpiration(content, futureTime);
    expect(getShareData(content)?.expiresAt).toBe(futureTime);

    updateShareExpiration(content, undefined);
    expect(getShareData(content)?.expiresAt).toBeUndefined();
  });

  it("should return undefined for expired content", () => {
    const content = "Hello, world!";
    const pastTime = Date.now() - 1000; // 1 second ago

    setShareData(content, {
      url: "https://mux.md/abc123#key",
      id: "abc123",
      mutateKey: "key123",
      expiresAt: pastTime,
    });

    // Should return undefined because it's expired
    expect(getShareData(content)).toBeUndefined();
    expect(getSharedUrl(content)).toBeUndefined();
  });

  it("should return data for non-expired content", () => {
    const content = "Hello, world!";
    const futureTime = Date.now() + 1000 * 60 * 60; // 1 hour from now

    setShareData(content, {
      url: "https://mux.md/abc123#key",
      id: "abc123",
      mutateKey: "key123",
      expiresAt: futureTime,
    });

    expect(getShareData(content)?.url).toBe("https://mux.md/abc123#key");
  });
});
