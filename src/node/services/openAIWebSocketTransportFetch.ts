import assert from "node:assert";
import { createWebSocketFetch as createOpenAIWebSocketFetch } from "@vercel/ai-sdk-openai-websocket-fetch";

type WebSocketFetch = typeof fetch & { close: () => void };
type WebSocketFetchFactory = () => WebSocketFetch;

interface CreateOpenAIWebSocketTransportFetchOptions {
  enabled: boolean;
  baseFetch: typeof fetch;
  createWebSocketFetch?: WebSocketFetchFactory;
}

interface OpenAIWebSocketTransportFetch {
  fetch: typeof fetch;
  close: () => void;
  active: boolean;
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}

function isStreamingResponsesRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init?.method?.toUpperCase() !== "POST") {
    return false;
  }

  if (!getRequestUrl(input).endsWith("/responses")) {
    return false;
  }

  if (typeof init?.body !== "string") {
    return false;
  }

  try {
    const body = JSON.parse(init.body) as { stream?: unknown };
    return body.stream === true;
  } catch {
    return false;
  }
}

export function createOpenAIWebSocketTransportFetch(
  options: CreateOpenAIWebSocketTransportFetchOptions
): OpenAIWebSocketTransportFetch {
  if (!options.enabled) {
    return {
      fetch: options.baseFetch,
      close: () => undefined,
      active: false,
    };
  }

  const webSocketFetchFactory = options.createWebSocketFetch ?? createOpenAIWebSocketFetch;
  const webSocketFetch = webSocketFetchFactory();
  assert(typeof webSocketFetch.close === "function", "OpenAI WebSocket fetch must expose close()");

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    webSocketFetch.close();
  };

  const baseFetchWithPreconnect = options.baseFetch as typeof fetch & {
    preconnect?: typeof fetch.preconnect;
  };
  const fetchExtras =
    typeof baseFetchWithPreconnect.preconnect === "function"
      ? { preconnect: baseFetchWithPreconnect.preconnect.bind(baseFetchWithPreconnect) }
      : {};
  const transportFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    // The upstream package falls through to globalThis.fetch for non-WebSocket requests.
    // Pre-filter here so Mux's existing fetch wrappers keep handling those HTTP paths.
    if (!isStreamingResponsesRequest(input, init)) {
      return options.baseFetch(input, init);
    }

    return webSocketFetch(input, init);
  }, fetchExtras) as typeof fetch;

  return {
    fetch: transportFetch,
    close,
    active: true,
  };
}
