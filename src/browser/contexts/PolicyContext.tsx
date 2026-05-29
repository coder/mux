import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import type {
  EffectivePolicy,
  PolicyGetResponse,
  PolicySource,
  PolicyStatus,
} from "@/common/orpc/types";
import { useAPI } from "@/browser/contexts/API";

interface PolicyContextValue {
  source: PolicySource;
  status: PolicyStatus;
  policy: EffectivePolicy | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const PolicyContext = createContext<PolicyContextValue | null>(null);

// User request: keep churn guard while still surfacing updated policy reasons.
const getPolicySignature = (response: PolicyGetResponse): string =>
  JSON.stringify({ status: response.status, policy: response.policy });

export function PolicyProvider(props: { children: React.ReactNode }) {
  const apiState = useAPI();
  const api = apiState.api;
  const [response, setResponse] = useState<PolicyGetResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!api) {
      setResponse(null);
      setLoading(false);
      return;
    }

    try {
      const next = await api.policy.get();
      // User request: avoid churn from identical payloads while letting reason updates through.
      setResponse((prev) => {
        if (!prev) {
          return next;
        }
        if (getPolicySignature(prev) === getPolicySignature(next)) {
          return prev;
        }
        return next;
      });
    } catch {
      setResponse((prev) => (prev ? null : prev));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!api) {
      setResponse(null);
      setLoading(false);
      return;
    }

    const abortController = new AbortController();
    const signal = abortController.signal;

    void refresh();

    (async () => {
      try {
        const iterator = await api.policy.onChanged(undefined, { signal });
        for await (const _ of iterator) {
          if (signal.aborted) {
            break;
          }
          void refresh();
        }
      } catch {
        // Expected on unmount.
      }
    })();

    return () => abortController.abort();
  }, [api, refresh]);

  const source: PolicySource = response?.source ?? "none";
  const status: PolicyStatus = response?.status ?? { state: "disabled" };
  const policy = response?.policy ?? null;

  return (
    <PolicyContext.Provider value={{ source, status, policy, loading, refresh }}>
      {props.children}
    </PolicyContext.Provider>
  );
}

export function usePolicy(): PolicyContextValue {
  const ctx = useContext(PolicyContext);
  if (!ctx) {
    throw new Error("usePolicy must be used within a PolicyProvider");
  }
  return ctx;
}
