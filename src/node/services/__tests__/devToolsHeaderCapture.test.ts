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

    // Captured headers include real headers but not the synthetic one
    const captured = consumeCapturedRequestHeaders("step-abc");
    expect(captured).not.toBeNull();
    expect(captured!["content-type"]).toBe("application/json");
    expect(captured!["x-api-key"]).toBe("sk-123");
    expect(captured!["user-agent"]).toBe("mux/1.0 ai-sdk/anthropic/3.0");
    expect(captured![DEVTOOLS_STEP_ID_HEADER]).toBeUndefined();
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
