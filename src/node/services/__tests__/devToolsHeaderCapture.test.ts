import { describe, expect, it } from "bun:test";
import {
  DEVTOOLS_STEP_ID_HEADER,
  captureAndStripDevToolsHeader,
  consumeCapturedRequestHeaders,
} from "../devToolsHeaderCapture";

describe("devToolsHeaderCapture", () => {
  it("captures headers and strips synthetic header from Headers object", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-api-key": "sk-123",
      "user-agent": "mux/1.0 ai-sdk/anthropic/3.0",
      [DEVTOOLS_STEP_ID_HEADER]: "step-abc",
    });

    captureAndStripDevToolsHeader(headers);

    // Synthetic header was stripped from the Headers object
    expect(headers.get(DEVTOOLS_STEP_ID_HEADER)).toBeNull();
    // Other headers remain intact
    expect(headers.get("content-type")).toBe("application/json");

    // Captured headers include real headers (redacted as needed) but not the synthetic one
    const captured = consumeCapturedRequestHeaders("step-abc");
    expect(captured).not.toBeNull();
    expect(captured!["content-type"]).toBe("application/json");
    expect(captured!["x-api-key"]).toBe("[REDACTED]");
    expect(captured!["user-agent"]).toBe("mux/1.0 ai-sdk/anthropic/3.0");
    expect(captured![DEVTOOLS_STEP_ID_HEADER]).toBeUndefined();
  });

  it("redacts sensitive headers before persisting captured metadata", () => {
    const headers = new Headers({
      authorization: "Bearer sk-abc",
      "x-api-key": "x-api-key-value",
      "api-key": "api-key-value",
      "x-goog-api-key": "x-goog-api-key-value",
      "x-session-token": "token-value",
      "client-secret": "secret-value",
      "content-type": "application/json",
      "user-agent": "mux/1.0 ai-sdk/openai/5.0",
      [DEVTOOLS_STEP_ID_HEADER]: "step-sensitive",
    });

    captureAndStripDevToolsHeader(headers);

    const captured = consumeCapturedRequestHeaders("step-sensitive");
    expect(captured).not.toBeNull();
    expect(captured!["authorization"]).toBe("[REDACTED]");
    expect(captured!["x-api-key"]).toBe("[REDACTED]");
    expect(captured!["api-key"]).toBe("[REDACTED]");
    expect(captured!["x-goog-api-key"]).toBe("[REDACTED]");
    expect(captured!["x-session-token"]).toBe("[REDACTED]");
    expect(captured!["client-secret"]).toBe("[REDACTED]");
    expect(captured!["content-type"]).toBe("application/json");
    expect(captured!["user-agent"]).toBe("mux/1.0 ai-sdk/openai/5.0");
  });

  it("consumeCapturedRequestHeaders returns null for unknown stepId", () => {
    expect(consumeCapturedRequestHeaders("unknown")).toBeNull();
  });

  it("consumeCapturedRequestHeaders cleans up after read", () => {
    const headers = new Headers({
      [DEVTOOLS_STEP_ID_HEADER]: "step-1",
    });
    captureAndStripDevToolsHeader(headers);

    consumeCapturedRequestHeaders("step-1"); // first read
    expect(consumeCapturedRequestHeaders("step-1")).toBeNull(); // second read → null
  });

  it("is a no-op when synthetic header is absent", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-api-key": "sk-123",
    });

    captureAndStripDevToolsHeader(headers);

    // Headers unchanged
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-api-key")).toBe("sk-123");
  });
});
