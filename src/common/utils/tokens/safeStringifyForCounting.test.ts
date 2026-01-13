import { describe, expect, test } from "bun:test";

import { safeStringifyForCounting } from "./safeStringifyForCounting";

describe("safeStringifyForCounting", () => {
  test("redacts AI SDK media blocks (base64)", () => {
    const input = {
      type: "media",
      data: "A".repeat(100_000),
      mediaType: "image/png",
    };

    const serialized = safeStringifyForCounting(input);

    expect(serialized).toContain("[omitted base64 len=100000]");
    expect(serialized).not.toContain("A".repeat(1024));
  });

  test("redacts base64 data URLs", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(1000)}`;

    const serialized = safeStringifyForCounting({ url: dataUrl });

    expect(serialized).toContain("data:image/png;base64,[omitted len=1000]");
    expect(serialized).not.toContain("A".repeat(256));
  });

  test("does not throw on circular structures", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;

    const serialized = safeStringifyForCounting(obj);

    expect(serialized).toContain("[circular]");
  });
});
