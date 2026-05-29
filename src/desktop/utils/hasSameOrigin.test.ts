import { describe, expect, test } from "bun:test";
import { hasSameOrigin } from "./hasSameOrigin";

describe("hasSameOrigin", () => {
  test("treats canonicalized dev-server URLs as the same origin", () => {
    expect(hasSameOrigin("http://127.0.0.1:5173/", "http://127.0.0.1:5173")).toBe(true);
  });

  test("allows different paths on the same origin", () => {
    expect(hasSameOrigin("http://127.0.0.1:5173/foo", "http://127.0.0.1:5173/bar")).toBe(true);
  });

  test("rejects different ports", () => {
    expect(hasSameOrigin("http://127.0.0.1:5173/", "http://127.0.0.1:5174/")).toBe(false);
  });

  test("rejects invalid URLs", () => {
    expect(hasSameOrigin("not-a-url", "http://127.0.0.1:5173/")).toBe(false);
  });
});
