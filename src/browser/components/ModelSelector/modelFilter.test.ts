import { describe, expect, test } from "bun:test";
import { modelMatchesQuery } from "./modelFilter";

describe("modelMatchesQuery", () => {
  test("matches model string substrings", () => {
    expect(modelMatchesQuery("google:gemini-3.6-flash", "3.6")).toBe(true);
    expect(modelMatchesQuery("google:gemini-3.6-flash", "sonnet")).toBe(false);
  });

  test("matches documented aliases that are not model string substrings", () => {
    expect(modelMatchesQuery("google:gemini-3.6-flash", "gemini-flash")).toBe(true);
    expect(modelMatchesQuery("deepseek:deepseek-v4-pro", "deepseek-pro")).toBe(true);
    expect(modelMatchesQuery("xai:grok-4-1-fast", "grok-4.1")).toBe(true);
  });

  test("matches aliases for gateway-prefixed model strings", () => {
    expect(modelMatchesQuery("mux-gateway:google/gemini-3.6-flash", "gemini-flash")).toBe(true);
  });

  test("does not match aliases belonging to other models", () => {
    expect(modelMatchesQuery("anthropic:claude-opus-4-8", "gemini-flash")).toBe(false);
  });
});
