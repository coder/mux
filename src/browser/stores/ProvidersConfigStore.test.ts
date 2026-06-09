import { describe, expect, mock, test } from "bun:test";
import { ProvidersConfigStore } from "./ProvidersConfigStore";
import type { APIClient } from "@/browser/contexts/API";
import type { ProvidersConfigMap } from "@/common/orpc/types";

const SAMPLE_CONFIG: ProvidersConfigMap = {
  anthropic: {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    models: [],
  },
};

function createClient(getConfig: () => Promise<ProvidersConfigMap>): Pick<APIClient, "providers"> {
  return {
    providers: {
      getConfig,
      // Keep the change subscription open without ever yielding so tests
      // exercise the fetch/optimistic paths deterministically.
      onConfigChanged: async function* () {
        yield* [];
        await new Promise<void>(() => undefined);
      },
    },
  } as unknown as Pick<APIClient, "providers">;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("ProvidersConfigStore", () => {
  test("loads once per client and serves every subscriber synchronously after", async () => {
    const getConfig = mock(() => Promise.resolve(SAMPLE_CONFIG));
    const store = new ProvidersConfigStore();

    expect(store.isLoaded()).toBe(false);
    store.setClient(createClient(getConfig) as APIClient);

    const notified = mock(() => undefined);
    store.subscribe(notified);
    store.subscribe(() => undefined);

    await waitUntil(() => store.isLoaded());
    expect(store.getConfig()).toEqual(SAMPLE_CONFIG);
    expect(notified).toHaveBeenCalled();
    // Subscribing more consumers must not trigger more fetches.
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  test("a failed fetch still marks the store loaded (self-heal, no stuck loading)", async () => {
    const store = new ProvidersConfigStore();
    store.setClient(createClient(() => Promise.reject(new Error("backend down"))) as APIClient);

    await waitUntil(() => store.isLoaded());
    expect(store.getConfig()).toBeNull();
  });

  test("optimistic updates win over stale in-flight fetch responses", async () => {
    let resolveSlowFetch: ((config: ProvidersConfigMap) => void) | null = null;
    let calls = 0;
    const getConfig = () => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(SAMPLE_CONFIG);
      }
      return new Promise<ProvidersConfigMap>((resolve) => {
        resolveSlowFetch = resolve;
      });
    };

    const store = new ProvidersConfigStore();
    store.setClient(createClient(getConfig) as APIClient);
    await waitUntil(() => store.isLoaded());

    // Start a slow refresh, then land an optimistic update while it is in flight.
    void store.refresh();
    await waitUntil(() => resolveSlowFetch !== null);
    store.updateOptimistically("anthropic", { apiKeySet: false });
    expect(store.getConfig()?.anthropic?.apiKeySet).toBe(false);

    // The stale response must NOT clobber the optimistic state.
    resolveSlowFetch!(SAMPLE_CONFIG);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.getConfig()?.anthropic?.apiKeySet).toBe(false);
  });
});
