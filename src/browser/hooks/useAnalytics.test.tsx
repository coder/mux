import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { OrpcServer } from "@/node/orpc/server";
import type { ORPCContext } from "@/node/orpc/context";
import type { SavedQuery } from "@/common/types/savedQueries";
import type { AnalyticsService } from "@/node/services/analytics/analyticsService";
import {
  useAnalyticsProviderCacheHitRatio,
  useAnalyticsRawQuery,
  useAnalyticsSpendByModel,
  useAnalyticsSummary,
  useSavedQueries,
  type Summary,
} from "./useAnalytics";

const ANALYTICS_UNAVAILABLE_MESSAGE = "Analytics backend is not available in this build.";

const summaryFixture: Summary = {
  totalSpendUsd: 42.25,
  todaySpendUsd: 1.75,
  avgDailySpendUsd: 5.28125,
  cacheHitRatio: 0.18,
  totalTokens: 4200,
  totalResponses: 84,
};

const savedQueriesFixture: SavedQuery[] = [
  {
    id: "saved-query-1",
    label: "Saved query",
    sql: "SELECT 1",
    chartType: "table",
    order: 0,
    createdAt: "2026-03-06T00:00:00.000Z",
  },
];

interface AnalyticsServiceCalls {
  summary: Array<{
    projectPath: string | null;
    from: Date | null | undefined;
    to: Date | null | undefined;
  }>;
  spendByModel: Array<{
    projectPath: string | null;
    from: Date | null | undefined;
    to: Date | null | undefined;
  }>;
  cacheHitRatioByProvider: Array<{
    projectPath: string | null;
    from: Date | null | undefined;
    to: Date | null | undefined;
  }>;
}

let currentApiClient: RouterClient<AppRouter> | null = null;
let analyticsServiceCalls: AnalyticsServiceCalls | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: currentApiClient }),
}));

void mock.module("@/version", () => ({
  VERSION: "test-version",
}));

function createHttpClient(baseUrl: string): RouterClient<AppRouter> {
  const link = new HTTPRPCLink({
    url: `${baseUrl}/orpc`,
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- typed test helper
  return createORPCClient(link) as RouterClient<AppRouter>;
}

function createFakeAnalyticsApiClient(
  overrides: {
    getSavedQueries?: () => Promise<{ queries: SavedQuery[] }>;
    updateSavedQuery?: (input: {
      id: string;
      label?: string;
      sql?: string;
      chartType?: string | null;
      order?: number;
    }) => Promise<SavedQuery>;
  } = {}
): RouterClient<AppRouter> {
  // Regression guard: getAnalyticsNamespace validates a full analytics namespace before exposing
  // saved-query helpers, so this fake includes the required surface even though these tests only
  // exercise saved-query loading/update flows.
  const analyticsNamespace = {
    getSummary: () => Promise.resolve(summaryFixture),
    getSpendOverTime: () => Promise.resolve([]),
    getSpendByProject: () => Promise.resolve([]),
    getSpendByModel: () => Promise.resolve([]),
    getTokensByModel: () => Promise.resolve([]),
    getTimingDistribution: () => Promise.resolve({ p50: 0, p90: 0, p99: 0, histogram: [] }),
    getAgentCostBreakdown: () => Promise.resolve([]),
    getCacheHitRatioByProvider: () => Promise.resolve([]),
    getDelegationSummary: () =>
      Promise.resolve({
        totalChildren: 0,
        totalTokensConsumed: 0,
        totalReportTokens: 0,
        compressionRatio: 0,
        totalCostDelegated: 0,
        byAgentType: [],
      }),
    ...overrides,
  };

  return {
    analytics: analyticsNamespace,
  } as unknown as RouterClient<AppRouter>;
}

type AnalyticsServiceStub = Pick<
  AnalyticsService,
  | "getSummary"
  | "getSpendOverTime"
  | "getSpendByProject"
  | "getSpendByModel"
  | "getTimingDistribution"
  | "getAgentCostBreakdown"
  | "getCacheHitRatioByProvider"
  | "rebuildAll"
  | "clearWorkspace"
  | "ingestWorkspace"
  | "executeRawQuery"
>;

function createAnalyticsServiceStub(summary: Summary): {
  service: AnalyticsServiceStub;
  calls: AnalyticsServiceCalls;
} {
  const calls: AnalyticsServiceCalls = {
    summary: [],
    spendByModel: [],
    cacheHitRatioByProvider: [],
  };

  return {
    calls,
    service: {
      getSummary: (projectPath, from, to) => {
        calls.summary.push({ projectPath, from, to });
        return Promise.resolve(summary);
      },
      getSpendOverTime: () => Promise.resolve([]),
      getSpendByProject: () => Promise.resolve([]),
      getSpendByModel: (projectPath, from, to) => {
        calls.spendByModel.push({ projectPath, from, to });
        return Promise.resolve([]);
      },
      getTimingDistribution: () => Promise.resolve({ p50: 0, p90: 0, p99: 0, histogram: [] }),
      getAgentCostBreakdown: () => Promise.resolve([]),
      getCacheHitRatioByProvider: (projectPath, from, to) => {
        calls.cacheHitRatioByProvider.push({ projectPath, from, to });
        return Promise.resolve([]);
      },
      rebuildAll: () => Promise.resolve({ success: true, workspacesIngested: 0 }),
      clearWorkspace: () => undefined,
      ingestWorkspace: () => undefined,
      executeRawQuery: () => Promise.reject(new Error("stub: not implemented")),
    },
  };
}

function requireAnalyticsServiceCalls(): AnalyticsServiceCalls {
  if (!analyticsServiceCalls) {
    throw new Error("Expected analytics service call tracking to be initialized");
  }
  return analyticsServiceCalls;
}

describe("useAnalytics hooks", () => {
  let server: OrpcServer | null = null;

  beforeEach(async () => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    const analyticsStub = createAnalyticsServiceStub(summaryFixture);
    analyticsServiceCalls = analyticsStub.calls;

    const context: Partial<ORPCContext> = {
      analyticsService: analyticsStub.service as unknown as ORPCContext["analyticsService"],
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
    analyticsServiceCalls = null;
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

  test("forwards from/to filters to summary endpoint", async () => {
    const from = new Date("2026-01-05T00:00:00.000Z");
    const to = new Date("2026-01-20T00:00:00.000Z");

    const { result } = renderHook(() => useAnalyticsSummary("/tmp/project", { from, to }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const calls = requireAnalyticsServiceCalls().summary;
    expect(calls.length).toBeGreaterThan(0);

    const latest = calls.at(-1);
    expect(latest).toBeDefined();
    if (!latest || !(latest.from instanceof Date) || !(latest.to instanceof Date)) {
      throw new Error("Expected summary call to include Date filters");
    }

    expect(latest.projectPath).toBe("/tmp/project");
    expect(latest.from.toISOString()).toBe(from.toISOString());
    expect(latest.to.toISOString()).toBe(to.toISOString());
  });

  test("forwards from/to filters to spend-by-model endpoint", async () => {
    const from = new Date("2026-01-07T00:00:00.000Z");
    const to = new Date("2026-01-27T00:00:00.000Z");

    const { result } = renderHook(() => useAnalyticsSpendByModel("/tmp/project", { from, to }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const calls = requireAnalyticsServiceCalls().spendByModel;
    expect(calls.length).toBeGreaterThan(0);

    const latest = calls.at(-1);
    expect(latest).toBeDefined();
    if (!latest || !(latest.from instanceof Date) || !(latest.to instanceof Date)) {
      throw new Error("Expected spend-by-model call to include Date filters");
    }

    expect(latest.projectPath).toBe("/tmp/project");
    expect(latest.from.toISOString()).toBe(from.toISOString());
    expect(latest.to.toISOString()).toBe(to.toISOString());
  });

  test("forwards from/to filters to provider cache-hit-ratio endpoint", async () => {
    const from = new Date("2026-01-09T00:00:00.000Z");
    const to = new Date("2026-01-30T00:00:00.000Z");

    const { result } = renderHook(() =>
      useAnalyticsProviderCacheHitRatio("/tmp/project", { from, to })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    const calls = requireAnalyticsServiceCalls().cacheHitRatioByProvider;
    expect(calls.length).toBeGreaterThan(0);

    const latest = calls.at(-1);
    expect(latest).toBeDefined();
    if (!latest || !(latest.from instanceof Date) || !(latest.to instanceof Date)) {
      throw new Error("Expected provider cache-hit-ratio call to include Date filters");
    }

    expect(latest.projectPath).toBe("/tmp/project");
    expect(latest.from.toISOString()).toBe(from.toISOString());
    expect(latest.to.toISOString()).toBe(to.toISOString());
  });

  test("useSavedQueries eagerly loads queries by default", async () => {
    const getSavedQueriesMock = mock(() => Promise.resolve({ queries: savedQueriesFixture }));
    currentApiClient = createFakeAnalyticsApiClient({ getSavedQueries: getSavedQueriesMock });

    const { result } = renderHook(() => useSavedQueries());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getSavedQueriesMock).toHaveBeenCalledTimes(1);
    expect(result.current.queries).toEqual(savedQueriesFixture);
  });

  test("useSavedQueries skips the mount load when requested and can still refresh", async () => {
    const getSavedQueriesMock = mock(() => Promise.resolve({ queries: savedQueriesFixture }));
    currentApiClient = createFakeAnalyticsApiClient({ getSavedQueries: getSavedQueriesMock });

    const { result } = renderHook(() => useSavedQueries({ skipLoad: true }));

    expect(result.current.loading).toBe(false);
    expect(getSavedQueriesMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getSavedQueriesMock).toHaveBeenCalledTimes(1);
    expect(result.current.queries).toEqual(savedQueriesFixture);
  });

  test("useSavedQueries forwards SQL updates and refreshes the saved-query list", async () => {
    const updatedQuery: SavedQuery = {
      ...savedQueriesFixture[0],
      sql: "SELECT 2",
    };
    let loadCount = 0;
    const getSavedQueriesMock = mock(() => {
      loadCount += 1;
      return Promise.resolve({
        queries: loadCount === 1 ? savedQueriesFixture : [updatedQuery],
      });
    });
    const updateSavedQueryMock = mock(() => Promise.resolve(updatedQuery));
    currentApiClient = createFakeAnalyticsApiClient({
      getSavedQueries: getSavedQueriesMock,
      updateSavedQuery: updateSavedQueryMock,
    });

    const { result } = renderHook(() => useSavedQueries());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.queries).toEqual(savedQueriesFixture);

    await act(async () => {
      await result.current.update({ id: updatedQuery.id, sql: updatedQuery.sql });
    });

    expect(updateSavedQueryMock).toHaveBeenCalledWith({
      id: updatedQuery.id,
      sql: updatedQuery.sql,
    });
    await waitFor(() => expect(getSavedQueriesMock).toHaveBeenCalledTimes(2));
    expect(result.current.queries).toEqual([updatedQuery]);
  });

  test("executeRawQuery surfaces backend error message instead of generic 500", async () => {
    const duckDbError = 'Binder Error: Referenced column "total_tokens" not found in FROM clause!';
    const analyticsStub = createAnalyticsServiceStub(summaryFixture);
    analyticsStub.service.executeRawQuery = () => Promise.reject(new Error(duckDbError));

    await server?.close();
    const context: Partial<ORPCContext> = {
      analyticsService: analyticsStub.service as unknown as ORPCContext["analyticsService"],
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

    const { result } = renderHook(() => useAnalyticsRawQuery());

    await act(async () => {
      await result.current.executeQuery("SELECT sum(total_tokens) FROM events;");
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toContain("total_tokens");
    expect(result.current.error).not.toBe("Internal server error");
    expect(result.current.data).toBeNull();
  });

  test("executeRawQuery keeps infrastructure failures as generic internal errors", async () => {
    const analyticsStub = createAnalyticsServiceStub(summaryFixture);
    analyticsStub.service.executeRawQuery = () =>
      Promise.reject(new Error("Analytics worker exited with code 1"));

    await server?.close();
    const context: Partial<ORPCContext> = {
      analyticsService: analyticsStub.service as unknown as ORPCContext["analyticsService"],
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

    const { result } = renderHook(() => useAnalyticsRawQuery());

    await act(async () => {
      await result.current.executeQuery("SELECT 1");
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Internal server error");
    expect(result.current.data).toBeNull();
  });
});
