import { describe, expect, test } from "bun:test";

import { createOpenAIWebSocketTransportFetch } from "./openAIWebSocketTransportFetch";

function getFetchInputUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

function createTestFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect.bind(fetch) }) as typeof fetch;
}

function createTestWebSocketFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  close: () => void = () => undefined
): typeof fetch & { close: () => void } {
  return Object.assign(createTestFetch(handler), { close });
}

describe("createOpenAIWebSocketTransportFetch", () => {
  test("disabled transport keeps using the base fetch and exposes inactive cleanup", async () => {
    const baseCalls: string[] = [];
    const baseFetch = createTestFetch((input: RequestInfo | URL, _init?: RequestInit) => {
      baseCalls.push(getFetchInputUrl(input));
      return Promise.resolve(new Response("base"));
    });

    const transport = createOpenAIWebSocketTransportFetch({
      enabled: false,
      baseFetch,
      createWebSocketFetch: () => {
        throw new Error("WebSocket fetch should not be created when disabled");
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(await response.text()).toBe("base");
    expect(baseCalls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(transport.active).toBe(false);
    expect(() => transport.close()).not.toThrow();
  });

  test("enabled transport sends streaming Responses API posts through WebSocket fetch", async () => {
    const wsCalls: string[] = [];
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () => {
        return createTestWebSocketFetch((input: RequestInfo | URL, _init?: RequestInit) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        });
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });

    expect(await response.text()).toBe("ws");
    expect(wsCalls).toEqual(["https://api.openai.com/v1/responses"]);
    expect(transport.active).toBe(true);
  });

  test("enabled transport keeps non-eligible requests on the base fetch", async () => {
    const baseCalls: string[] = [];
    const wsCalls: string[] = [];
    const baseFetch = createTestFetch((input: RequestInfo | URL, _init?: RequestInit) => {
      baseCalls.push(getFetchInputUrl(input));
      return Promise.resolve(new Response("base"));
    });

    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch,
      createWebSocketFetch: () => {
        return createTestWebSocketFetch((input: RequestInfo | URL, _init?: RequestInit) => {
          wsCalls.push(getFetchInputUrl(input));
          return Promise.resolve(new Response("ws"));
        });
      },
    });

    const response = await transport.fetch("https://api.openai.com/v1/models", {
      method: "GET",
    });

    expect(await response.text()).toBe("base");
    expect(baseCalls).toEqual(["https://api.openai.com/v1/models"]);
    expect(wsCalls).toEqual([]);
  });

  test("close is idempotent", () => {
    let closeCalls = 0;
    const transport = createOpenAIWebSocketTransportFetch({
      enabled: true,
      baseFetch: createTestFetch(() => Promise.resolve(new Response("base"))),
      createWebSocketFetch: () =>
        createTestWebSocketFetch(
          () => Promise.resolve(new Response("ws")),
          () => {
            closeCalls += 1;
          }
        ),
    });

    transport.close();
    transport.close();

    expect(closeCalls).toBe(1);
  });
});
