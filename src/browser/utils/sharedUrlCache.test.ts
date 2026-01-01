import { describe, it, expect, beforeEach } from "bun:test";
import { getSharedUrl, setSharedUrl } from "./sharedUrlCache";

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

describe("sharedUrlCache", () => {
  it("should store and retrieve a URL for content", () => {
    const content = "Hello, world!";
    const url = "https://mux.md/abc123#key";

    setSharedUrl(content, url);
    expect(getSharedUrl(content)).toBe(url);
  });

  it("should return undefined for unknown content", () => {
    expect(getSharedUrl("unknown content")).toBeUndefined();
  });

  it("should overwrite existing URL for same content", () => {
    const content = "Hello, world!";
    const url1 = "https://mux.md/abc123#key1";
    const url2 = "https://mux.md/def456#key2";

    setSharedUrl(content, url1);
    setSharedUrl(content, url2);
    expect(getSharedUrl(content)).toBe(url2);
  });

  it("should use different keys for different content", () => {
    const content1 = "Content A";
    const content2 = "Content B";
    const url1 = "https://mux.md/abc123#key1";
    const url2 = "https://mux.md/def456#key2";

    setSharedUrl(content1, url1);
    setSharedUrl(content2, url2);

    expect(getSharedUrl(content1)).toBe(url1);
    expect(getSharedUrl(content2)).toBe(url2);
  });

  it("should handle empty content", () => {
    const url = "https://mux.md/abc123#key";
    setSharedUrl("", url);
    expect(getSharedUrl("")).toBe(url);
  });

  it("should handle content with special characters", () => {
    const content = "Hello! @#$%^&*() 你好 🎉";
    const url = "https://mux.md/abc123#key";

    setSharedUrl(content, url);
    expect(getSharedUrl(content)).toBe(url);
  });
});
