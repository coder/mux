import { describe, expect, test } from "bun:test";
import type { NameGenerationError } from "@/common/types/errors";
import { formatNameGenerationError } from "./formatNameGenerationError";

const format = (error: NameGenerationError) => formatNameGenerationError(error);

describe("formatNameGenerationError", () => {
  test("formats authentication errors with provider context", () => {
    const formatted = format({ type: "authentication", provider: "anthropic" });

    expect(formatted.title).toContain("Authentication");
    expect(formatted.hint).toContain("Settings");
  });

  test("formats authentication errors without provider", () => {
    const formatted = format({ type: "authentication" });

    expect(formatted.title).toContain("Authentication");
    expect(formatted.message).toBe("API key is missing or invalid.");
  });

  test("formats permission_denied as access denied", () => {
    const formatted = format({ type: "permission_denied", provider: "openai" });

    expect(formatted.title).toBe("Access denied");
  });

  test("formats rate_limit with waiting hint", () => {
    const formatted = format({ type: "rate_limit" });

    expect(formatted.title).toBe("Rate limited");
    expect(formatted.hint?.toLowerCase()).toContain("wait");
  });

  test("formats quota with docs path", () => {
    const formatted = format({ type: "quota" });

    expect(formatted.title).toBe("Quota exceeded");
    expect(formatted.docsPath).toBe("/config/providers");
  });

  test("formats service_unavailable", () => {
    const formatted = format({ type: "service_unavailable" });

    expect(formatted.title).toBe("Service unavailable");
  });

  test("formats network errors", () => {
    const formatted = format({ type: "network" });

    expect(formatted.title).toBe("Network error");
  });

  test("formats configuration issues and includes raw message", () => {
    const formatted = format({ type: "configuration", raw: "Provider disabled" });

    expect(formatted.title).toBe("Configuration issue");
    expect(formatted.message).toContain("Provider disabled");
  });

  test("formats unknown errors with provided raw message", () => {
    const formatted = format({ type: "unknown", raw: "Some error" });

    expect(formatted.title).toBe("Name generation failed");
  });

  test("formats unknown errors with fallback message when raw is empty", () => {
    const formatted = format({ type: "unknown", raw: "" });

    expect(formatted.message).not.toBe("");
  });
});
