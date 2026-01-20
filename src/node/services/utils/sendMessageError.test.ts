import { describe, expect, test } from "bun:test";
import {
  buildStreamErrorEventData,
  createUnknownSendMessageError,
  formatSendMessageError,
} from "./sendMessageError";

describe("buildStreamErrorEventData", () => {
  test("builds a stream-error payload with a synthetic messageId", () => {
    const result = buildStreamErrorEventData({
      type: "api_key_not_found",
      provider: "openai",
    });

    expect(result.errorType).toBe("authentication");
    expect(result.error).toContain("openai");
    expect(result.messageId).toMatch(/^assistant-/);
  });
});
describe("formatSendMessageError", () => {
  test("formats api_key_not_found with authentication errorType", () => {
    const result = formatSendMessageError({
      type: "api_key_not_found",
      provider: "anthropic",
    });

    expect(result.errorType).toBe("authentication");
    expect(result.message).toContain("anthropic");
    expect(result.message).toContain("API key");
  });

  test("formats provider_not_supported", () => {
    const result = formatSendMessageError({
      type: "provider_not_supported",
      provider: "unsupported-provider",
    });

    expect(result.errorType).toBe("unknown");
    expect(result.message).toContain("unsupported-provider");
    expect(result.message).toContain("not supported");
  });

  test("formats invalid_model_string with model_not_found errorType", () => {
    const result = formatSendMessageError({
      type: "invalid_model_string",
      message: "Invalid model format: foo",
    });

    expect(result.errorType).toBe("model_not_found");
    expect(result.message).toBe("Invalid model format: foo");
  });

  test("formats incompatible_workspace", () => {
    const result = formatSendMessageError({
      type: "incompatible_workspace",
      message: "Workspace is incompatible",
    });

    expect(result.errorType).toBe("unknown");
    expect(result.message).toBe("Workspace is incompatible");
  });

  test("formats unknown errors", () => {
    const result = formatSendMessageError({
      type: "unknown",
      raw: "Something went wrong",
    });

    expect(result.errorType).toBe("unknown");
    expect(result.message).toBe("Something went wrong");
  });
});

describe("createUnknownSendMessageError", () => {
  test("creates unknown error with trimmed message", () => {
    const result = createUnknownSendMessageError("  test error  ");

    expect(result).toEqual({ type: "unknown", raw: "test error" });
  });

  test("throws on empty message", () => {
    expect(() => createUnknownSendMessageError("")).toThrow();
    expect(() => createUnknownSendMessageError("   ")).toThrow();
  });
});
