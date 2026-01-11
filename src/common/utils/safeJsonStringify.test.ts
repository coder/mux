import { safeJsonStringify } from "./safeJsonStringify";

describe("safeJsonStringify", () => {
  it("redacts AI SDK media/image base64 payloads", () => {
    const base64 = "A".repeat(50_000);
    const json = safeJsonStringify({
      type: "content",
      value: [{ type: "media", mediaType: "image/png", data: base64 }],
    });

    expect(json).toContain("[omitted image data");
    expect(json).toContain("image/png");
    expect(json).not.toMatch(/[A]{1000,}/);
  });

  it("redacts data URLs", () => {
    const base64 = "A".repeat(50_000);
    const json = safeJsonStringify({ url: `data:image/png;base64,${base64}` });

    expect(json).toContain("data:image/png;base64,");
    expect(json).toContain("[omitted len=");
    expect(json).not.toMatch(/[A]{1000,}/);
  });

  it("does not throw on circular objects", () => {
    const obj: { self?: unknown } = {};
    obj.self = obj;

    const json = safeJsonStringify(obj);
    expect(json).toContain("[Circular]");
  });
});
