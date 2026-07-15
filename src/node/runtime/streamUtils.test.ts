import { describe, expect, it } from "bun:test";

import { streamToString, streamToStringCapped } from "./streamUtils";

function chunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("streamToStringCapped", () => {
  it("returns full content when under the cap", async () => {
    const result = await streamToStringCapped(chunkedStream(["hello ", "world"]), 1024);
    expect(result).toBe("hello world");
  });

  it("caps accumulation at maxBytes and drains the remainder without failing", async () => {
    // 3 chunks of 10 bytes; cap at 15 → first chunk + half of second, third drained.
    const result = await streamToStringCapped(
      chunkedStream(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]),
      15
    );
    expect(result).toBe("aaaaaaaaaabbbbb");
  });

  it("matches streamToString for content exactly at the cap", async () => {
    const chunks = ["12345", "67890"];
    const capped = await streamToStringCapped(chunkedStream(chunks), 10);
    const full = await streamToString(chunkedStream(chunks));
    expect(capped).toBe(full);
  });

  it("drops a code point split by the cap instead of emitting U+FFFD", async () => {
    // "é" is 2 bytes in UTF-8; cap of 7 splits it after "hello " (6 bytes) + 1 byte.
    const result = await streamToStringCapped(chunkedStream(["hello é world"]), 7);
    expect(result).toBe("hello ");
    expect(result).not.toContain("\uFFFD");
  });

  it("rejects negative caps", async () => {
    let error: unknown = null;
    try {
      await streamToStringCapped(chunkedStream(["x"]), -1);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("maxBytes must be a non-negative number");
  });
});
