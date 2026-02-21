import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { OrpcServer } from "@/node/orpc/server";
import type { ORPCContext } from "@/node/orpc/context";
import type { AnalyticsService } from "@/node/services/analytics/analyticsService";
import { useAnalyticsSummary, type Summary } from "./useAnalytics";

const ANALYTICS_UNAVAILABLE_MESSAGE = "Analytics backend is not available in this build.";

const summaryFixture: Summary = {
  totalSpendUsd: 42.25,
  todaySpendUsd: 1.75,
  avgDailySpendUsd: 5.28125,
  cacheHitRatio: 0.18,
  totalTokens: 4200,
  totalResponses: 84,
};

let currentApiClient: RouterClient<AppRouter> | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: currentApiClient }),
}));

function createHttpClient(baseUrl: string): RouterClient<AppRouter> {
  const link = new HTTPRPCLink({
    url: `${baseUrl}/orpc`,
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- typed test helper
  return createORPCClient(link) as RouterClient<AppRouter>;
}

type AnalyticsServiceStub = Pick<
  AnalyticsService,
  | "getSummary"
  | "getSpendOverTime"
  | "getSpendByProject"
  | "getSpendByModel"
  | "getTimingDistribution"
  | "getAgentCostBreakdown"
  | "rebuildAll"
  | "clearWorkspace"
  | "ingestWorkspace"
>;

function createAnalyticsServiceStub(summary: Summary): AnalyticsServiceStub {
  return {
    getSummary: () => Promise.resolve(summary),
    getSpendOverTime: () => Promise.resolve([]),
    getSpendByProject: () => Promise.resolve([]),
    getSpendByModel: () => Promise.resolve([]),
    getTimingDistribution: () => Promise.resolve({ p50: 0, p90: 0, p99: 0, histogram: [] }),
    getAgentCostBreakdown: () => Promise.resolve([]),
    rebuildAll: () => Promise.resolve({ success: true, workspacesIngested: 0 }),
    clearWorkspace: () => undefined,
    ingestWorkspace: () => undefined,
  };
}

describe("useAnalyticsSummary", () => {
  let server: OrpcServer | null = null;

  beforeEach(async () => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    const context: Partial<ORPCContext> = {
      analyticsService: createAnalyticsServiceStub(
        summaryFixture
      ) as unknown as ORPCContext["analyticsService"],
    };

    // eslint-disable-next-line no-restricted-syntax -- test-only dynamic import avoids browser/node boundary lint
    const { createOrpcServer } = await import("@/node/orpc/server");

    server = await createOrpcServer({
      host: "127.0.0.1",
      port: 0,
      context: context as ORPCContext,
      onOrpcError: () => undefined,
    });

    currentApiClient = createHttpClient(server.baseUrl);
  });

  afterEach(async () => {
    cleanup();
    currentApiClient = null;
    await server?.close();
    server = null;
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("loads summary from a real ORPC client without backend-unavailable false negatives", async () => {
    const apiClient = currentApiClient;
    expect(apiClient).not.toBeNull();
    if (!apiClient) {
      throw new Error("Expected ORPC test client to be initialized");
    }

    // Regression guard: analytics namespace can be a callable proxy function.
    expect(typeof (apiClient as { analytics: unknown }).analytics).toBe("function");

    const { result } = renderHook(() => useAnalyticsSummary());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).not.toBe(ANALYTICS_UNAVAILABLE_MESSAGE);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(summaryFixture);
  });
});
