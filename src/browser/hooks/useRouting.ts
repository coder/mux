import { useCallback, useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import {
  availableRoutes as listAvailableRoutes,
  resolveRoute as resolveRouteForModel,
  type AvailableRoute,
  type RouteContext,
} from "@/common/routing";
import { normalizeToCanonical } from "@/common/utils/ai/models";

import { useProvidersConfig } from "./useProvidersConfig";

const DEFAULT_ROUTE_PRIORITY = ["direct"];

function getRouteDisplayName(route: string): string {
  if (route === "direct") {
    return "Direct";
  }

  if (route in PROVIDER_DEFINITIONS) {
    return PROVIDER_DEFINITIONS[route as ProviderName].displayName;
  }

  return route;
}

export interface RoutingState {
  /** Ordered route priority list */
  routePriority: string[];
  /** Per-model route overrides */
  routeOverrides: Record<string, string>;

  /** What route will be used for a given canonical model? */
  resolveRoute(canonicalModel: string): {
    route: string;
    isAuto: boolean;
    displayName: string;
  };

  /** Which routes can reach a given model's origin? */
  availableRoutes(canonicalModel: string): AvailableRoute[];

  /** Set the full priority list (drag-reorder) */
  setRoutePriority(priority: string[]): void;

  /** Set/clear a per-model override */
  setRouteOverride(canonicalModel: string, route: string | null): void;
}

export function useRouting(): RoutingState {
  const { api } = useAPI();
  const { config: providersConfig } = useProvidersConfig();
  const [routePriority, setRoutePriorityState] = useState<string[]>(DEFAULT_ROUTE_PRIORITY);
  const [routeOverrides, setRouteOverridesState] = useState<Record<string, string>>({});
  // Ignore stale config fetches so backend refreshes can't overwrite newer optimistic edits.
  const fetchVersionRef = useRef(0);

  const fetchRoutingConfig = useCallback(async () => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const fetchVersion = ++fetchVersionRef.current;

    try {
      const config = await getConfig();
      if (fetchVersion !== fetchVersionRef.current) {
        return;
      }

      setRoutePriorityState(config.routePriority ?? DEFAULT_ROUTE_PRIORITY);
      setRouteOverridesState(config.routeOverrides ?? {});
    } catch {
      // Best-effort only.
    }
  }, [api]);

  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!onConfigChanged) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    void fetchRoutingConfig();

    (async () => {
      try {
        const subscribedIterator = await onConfigChanged(undefined, { signal });

        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          void fetchRoutingConfig();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, fetchRoutingConfig]);

  const isConfigured = useCallback(
    (provider: string) =>
      providersConfig?.[provider]?.isConfigured === true &&
      providersConfig?.[provider]?.isEnabled !== false,
    [providersConfig]
  );

  const persistRoutePreferences = useCallback(
    (priority: string[], overrides: Record<string, string>) => {
      if (!api?.config?.updateRoutePreferences) {
        return;
      }

      api.config
        .updateRoutePreferences({
          routePriority: priority,
          routeOverrides: overrides,
        })
        .catch(() => {
          // Best-effort only; backend config reload will reconcile state.
        });
    },
    [api]
  );

  const setRoutePriority = useCallback(
    (priority: string[]) => {
      fetchVersionRef.current++;
      setRoutePriorityState(priority);
      persistRoutePreferences(priority, routeOverrides);
    },
    [persistRoutePreferences, routeOverrides]
  );

  const setRouteOverride = useCallback(
    (canonicalModel: string, route: string | null) => {
      fetchVersionRef.current++;
      const key = normalizeToCanonical(canonicalModel);
      const nextOverrides = { ...routeOverrides };
      if (route == null) {
        delete nextOverrides[key];
      } else {
        nextOverrides[key] = route;
      }

      setRouteOverridesState(nextOverrides);
      persistRoutePreferences(routePriority, nextOverrides);
    },
    [persistRoutePreferences, routeOverrides, routePriority]
  );

  const resolveRoute = useCallback(
    (canonicalModel: string) => {
      const normalized = normalizeToCanonical(canonicalModel);
      const resolved: RouteContext = resolveRouteForModel(
        canonicalModel,
        routePriority,
        routeOverrides,
        isConfigured
      );

      const route = resolved.routeProvider === resolved.origin ? "direct" : resolved.routeProvider;
      const override = routeOverrides[normalized];
      const overrideUsed =
        override != null &&
        (override === "direct" || override === resolved.origin
          ? route === "direct"
          : route === override);

      return {
        route,
        isAuto: !overrideUsed,
        displayName: getRouteDisplayName(route),
      };
    },
    [isConfigured, routeOverrides, routePriority]
  );

  const availableRoutes = useCallback(
    (canonicalModel: string): AvailableRoute[] => listAvailableRoutes(canonicalModel, isConfigured),
    [isConfigured]
  );

  return {
    routePriority,
    routeOverrides,
    resolveRoute,
    availableRoutes,
    setRoutePriority,
    setRouteOverride,
  };
}
