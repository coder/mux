import assert from "@/common/utils/assert";
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { APIClient } from "@/browser/contexts/API";
import { useAPI } from "@/browser/contexts/API";
import type { analytics } from "@/common/orpc/schemas/analytics";
import { getErrorMessage } from "@/common/utils/errors";

export type Summary = z.infer<typeof analytics.getSummary.output>;
export type SpendOverTimeItem = z.infer<typeof analytics.getSpendOverTime.output>[number];
export type SpendByProjectItem = z.infer<typeof analytics.getSpendByProject.output>[number];
export type SpendByModelItem = z.infer<typeof analytics.getSpendByModel.output>[number];
export type TimingDistribution = z.infer<typeof analytics.getTimingDistribution.output>;
export type AgentCostItem = z.infer<typeof analytics.getAgentCostBreakdown.output>[number];

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

type SummaryInput = z.input<typeof analytics.getSummary.input>;
type SpendOverTimeInput = z.input<typeof analytics.getSpendOverTime.input>;
type SpendByProjectInput = z.input<typeof analytics.getSpendByProject.input>;
type SpendByModelInput = z.input<typeof analytics.getSpendByModel.input>;
type TimingDistributionInput = z.input<typeof analytics.getTimingDistribution.input>;
type AgentCostBreakdownInput = z.input<typeof analytics.getAgentCostBreakdown.input>;

interface AnalyticsNamespace {
  getSummary: (input: SummaryInput) => Promise<Summary>;
  getSpendOverTime: (input: SpendOverTimeInput) => Promise<SpendOverTimeItem[]>;
  getSpendByProject: (input: SpendByProjectInput) => Promise<SpendByProjectItem[]>;
  getSpendByModel: (input: SpendByModelInput) => Promise<SpendByModelItem[]>;
  getTimingDistribution: (input: TimingDistributionInput) => Promise<TimingDistribution>;
  getAgentCostBreakdown: (input: AgentCostBreakdownInput) => Promise<AgentCostItem[]>;
}

const ANALYTICS_UNAVAILABLE_MESSAGE = "Analytics backend is not available in this build.";

function getAnalyticsNamespace(api: APIClient): AnalyticsNamespace | null {
  const candidate = (api as { analytics?: unknown }).analytics;
  // ORPC client namespaces can be proxy objects or callable proxy functions
  // depending on transport/runtime shape. Accept both so we don't
  // misclassify a valid analytics backend as unavailable.
  if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
    return null;
  }

  const maybeNamespace = candidate as Partial<AnalyticsNamespace>;
  if (
    typeof maybeNamespace.getSummary !== "function" ||
    typeof maybeNamespace.getSpendOverTime !== "function" ||
    typeof maybeNamespace.getSpendByProject !== "function" ||
    typeof maybeNamespace.getSpendByModel !== "function" ||
    typeof maybeNamespace.getTimingDistribution !== "function" ||
    typeof maybeNamespace.getAgentCostBreakdown !== "function"
  ) {
    return null;
  }

  return maybeNamespace as AnalyticsNamespace;
}

export function useAnalyticsSummary(projectPath?: string | null): AsyncState<Summary> {
  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<Summary>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!api) {
      setState((previousState) => ({
        data: previousState.data,
        loading: true,
        error: null,
      }));
      return;
    }

    const analyticsApi = getAnalyticsNamespace(api);
    if (!analyticsApi) {
      setState({ data: null, loading: false, error: ANALYTICS_UNAVAILABLE_MESSAGE });
      return;
    }

    let ignore = false;
    setState((previousState) => ({
      data: previousState.data,
      loading: true,
      error: null,
    }));

    void analyticsApi
      .getSummary({ projectPath: projectPath ?? null })
      .then((data) => {
        if (ignore) {
          return;
        }
        setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setState((previousState) => ({
          data: previousState.data,
          loading: false,
          error: getErrorMessage(error),
        }));
      });

    return () => {
      ignore = true;
    };
  }, [api, projectPath]);

  return state;
}

export function useAnalyticsSpendOverTime(params: {
  projectPath?: string | null;
  granularity: "hour" | "day" | "week";
  from?: Date | null;
  to?: Date | null;
}): AsyncState<SpendOverTimeItem[]> {
  assert(
    params.granularity === "hour" || params.granularity === "day" || params.granularity === "week",
    "useAnalyticsSpendOverTime requires a valid granularity"
  );

  const fromMs = params.from?.getTime() ?? null;
  const toMs = params.to?.getTime() ?? null;

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<SpendOverTimeItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!api) {
      setState((previousState) => ({
        data: previousState.data,
        loading: true,
        error: null,
      }));
      return;
    }

    const analyticsApi = getAnalyticsNamespace(api);
    if (!analyticsApi) {
      setState({ data: null, loading: false, error: ANALYTICS_UNAVAILABLE_MESSAGE });
      return;
    }

    let ignore = false;
    setState((previousState) => ({
      data: previousState.data,
      loading: true,
      error: null,
    }));

    const fromDate = fromMs == null ? null : new Date(fromMs);
    const toDate = toMs == null ? null : new Date(toMs);

    void analyticsApi
      .getSpendOverTime({
        projectPath: params.projectPath ?? null,
        granularity: params.granularity,
        from: fromDate,
        to: toDate,
      })
      .then((data) => {
        if (ignore) {
          return;
        }
        setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setState((previousState) => ({
          data: previousState.data,
          loading: false,
          error: getErrorMessage(error),
        }));
      });

    return () => {
      ignore = true;
    };
  }, [api, params.projectPath, params.granularity, fromMs, toMs]);

  return state;
}

export function useAnalyticsSpendByProject(): AsyncState<SpendByProjectItem[]> {
  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<SpendByProjectItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!api) {
      setState((previousState) => ({
        data: previousState.data,
        loading: true,
        error: null,
      }));
      return;
    }

    const analyticsApi = getAnalyticsNamespace(api);
    if (!analyticsApi) {
      setState({ data: null, loading: false, error: ANALYTICS_UNAVAILABLE_MESSAGE });
      return;
    }

    let ignore = false;
    setState((previousState) => ({
      data: previousState.data,
      loading: true,
      error: null,
    }));

    void analyticsApi
      .getSpendByProject({})
      .then((data) => {
        if (ignore) {
          return;
        }
        setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setState((previousState) => ({
          data: previousState.data,
          loading: false,
          error: getErrorMessage(error),
        }));
      });

    return () => {
      ignore = true;
    };
  }, [api]);

  return state;
}

export function useAnalyticsSpendByModel(
  projectPath?: string | null
): AsyncState<SpendByModelItem[]> {
  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<SpendByModelItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!api) {
      setState((previousState) => ({
        data: previousState.data,
        loading: true,
        error: null,
      }));
      return;
    }

    const analyticsApi = getAnalyticsNamespace(api);
    if (!analyticsApi) {
      setState({ data: null, loading: false, error: ANALYTICS_UNAVAILABLE_MESSAGE });
      return;
    }

    let ignore = false;
    setState((previousState) => ({
      data: previousState.data,
      loading: true,
      error: null,
    }));

    void analyticsApi
      .getSpendByModel({ projectPath: projectPath ?? null })
      .then((data) => {
        if (ignore) {
          return;
        }
        setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setState((previousState) => ({
          data: previousState.data,
          loading: false,
          error: getErrorMessage(error),
        }));
      });

    return () => {
      ignore = true;
    };
  }, [api, projectPath]);

  return state;
}

export function useAnalyticsTimingDistribution(
  metric: "ttft" | "duration" | "tps",
  projectPath?: string | null
): AsyncState<TimingDistribution> {
  assert(
    metric === "ttft" || metric === "duration" || metric === "tps",
    "useAnalyticsTimingDistribution requires a valid metric"
  );

  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<TimingDistribution>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!api) {
      setState((previousState) => ({
        data: previousState.data,
        loading: true,
        error: null,
      }));
      return;
    }

    const analyticsApi = getAnalyticsNamespace(api);
    if (!analyticsApi) {
      setState({ data: null, loading: false, error: ANALYTICS_UNAVAILABLE_MESSAGE });
      return;
    }

    let ignore = false;
    setState((previousState) => ({
      data: previousState.data,
      loading: true,
      error: null,
    }));

    void analyticsApi
      .getTimingDistribution({ metric, projectPath: projectPath ?? null })
      .then((data) => {
        if (ignore) {
          return;
        }
        setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setState((previousState) => ({
          data: previousState.data,
          loading: false,
          error: getErrorMessage(error),
        }));
      });

    return () => {
      ignore = true;
    };
  }, [api, metric, projectPath]);

  return state;
}

export function useAnalyticsAgentCostBreakdown(
  projectPath?: string | null
): AsyncState<AgentCostItem[]> {
  const { api } = useAPI();
  const [state, setState] = useState<AsyncState<AgentCostItem[]>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!api) {
      setState((previousState) => ({
        data: previousState.data,
        loading: true,
        error: null,
      }));
      return;
    }

    const analyticsApi = getAnalyticsNamespace(api);
    if (!analyticsApi) {
      setState({ data: null, loading: false, error: ANALYTICS_UNAVAILABLE_MESSAGE });
      return;
    }

    let ignore = false;
    setState((previousState) => ({
      data: previousState.data,
      loading: true,
      error: null,
    }));

    void analyticsApi
      .getAgentCostBreakdown({ projectPath: projectPath ?? null })
      .then((data) => {
        if (ignore) {
          return;
        }
        setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setState((previousState) => ({
          data: previousState.data,
          loading: false,
          error: getErrorMessage(error),
        }));
      });

    return () => {
      ignore = true;
    };
  }, [api, projectPath]);

  return state;
}
