import { describe, expect, it, vi } from "bun:test";
import {
  DEVTOOLS_STEP_ID_HEADER,
  consumeCapturedRequestHeaders,
  wrapFetchWithHeaderCapture,
} from "@/node/services/devToolsHeaderCapture";

function createMockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = () =>
    Promise.resolve(new Response("ok"))
) {
  const mockFetch = vi.fn(implementation);
  const fetchWithPreconnect = Object.assign(mockFetch, {
    preconnect: fetch.preconnect.bind(fetch),
  }) as unknown as typeof fetch;

  return {
    mockFetch,
    fetchWithPreconnect,
  };
}

describe("devToolsHeaderCapture", () => {
  it("wrapFetchWithHeaderCapture captures and strips synthetic header", async () => {
    const { mockFetch, fetchWithPreconnect } = createMockFetch();
    const wrapped = wrapFetchWithHeaderCapture(fetchWithPreconnect);

    await wrapped("https://api.example.com", {
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-123",
        [DEVTOOLS_STEP_ID_HEADER]: "step-abc",
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const sentInit = mockFetch.mock.calls[0]?.[1];
    expect(sentInit).toBeDefined();
    const sentHeaders = new Headers(sentInit?.headers);

    expect(sentHeaders.get(DEVTOOLS_STEP_ID_HEADER)).toBeNull();
    expect(sentHeaders.get("content-type")).toBe("application/json");
    expect(sentHeaders.get("x-api-key")).toBe("sk-123");

    const captured = consumeCapturedRequestHeaders("step-abc");
    expect(captured).not.toBeNull();
    expect(captured?.["content-type"]).toBe("application/json");
    expect(captured?.["x-api-key"]).toBe("sk-123");
    expect(captured?.[DEVTOOLS_STEP_ID_HEADER]).toBeUndefined();
  });

  it("consumeCapturedRequestHeaders returns null for unknown stepId", () => {
    expect(consumeCapturedRequestHeaders("unknown-step-id")).toBeNull();
  });

  it("consumeCapturedRequestHeaders cleans up after read", async () => {
    const { fetchWithPreconnect } = createMockFetch();
    const wrapped = wrapFetchWithHeaderCapture(fetchWithPreconnect);

    await wrapped("https://api.example.com", {
      headers: { [DEVTOOLS_STEP_ID_HEADER]: "step-cleanup" },
    });

    expect(consumeCapturedRequestHeaders("step-cleanup")).not.toBeNull();
    expect(consumeCapturedRequestHeaders("step-cleanup")).toBeNull();
  });

  it("passes through unchanged when no synthetic header is present", async () => {
    const { mockFetch, fetchWithPreconnect } = createMockFetch();
    const wrapped = wrapFetchWithHeaderCapture(fetchWithPreconnect);
    const init: RequestInit = { headers: { "x-api-key": "sk-123" } };

    await wrapped("https://api.example.com", init);

    expect(mockFetch).toHaveBeenCalledWith("https://api.example.com", init);
  });
});
