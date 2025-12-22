import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useExperiment,
  useExperimentValue,
  useRemoteExperimentValue,
} from "@/browser/contexts/ExperimentsContext";
import {
  getExperimentList,
  EXPERIMENT_IDS,
  type ExperimentId,
} from "@/common/constants/experiments";
import { Switch } from "@/browser/components/ui/switch";
import { Button } from "@/browser/components/ui/button";
import { CopyButton } from "@/browser/components/ui/CopyButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import type { ApiServerStatus } from "@/common/orpc/types";
import { Input } from "@/browser/components/ui/input";
import { useAPI } from "@/browser/contexts/API";
import { useFeatureFlags } from "@/browser/contexts/FeatureFlagsContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useTelemetry } from "@/browser/hooks/useTelemetry";

interface ExperimentRowProps {
  experimentId: ExperimentId;
  name: string;
  description: string;
  onToggle?: (enabled: boolean) => void;
}

function ExperimentRow(props: ExperimentRowProps) {
  const [enabled, setEnabled] = useExperiment(props.experimentId);
  const remote = useRemoteExperimentValue(props.experimentId);
  const telemetry = useTelemetry();
  const { onToggle, experimentId } = props;

  const handleToggle = useCallback(
    (value: boolean) => {
      setEnabled(value);
      // Track the override for analytics
      telemetry.experimentOverridden(experimentId, remote?.value ?? null, value);
      onToggle?.(value);
    },
    [setEnabled, telemetry, experimentId, remote?.value, onToggle]
  );

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-foreground text-sm font-medium">{props.name}</div>
        <div className="text-muted mt-0.5 text-xs">{props.description}</div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={handleToggle}
        aria-label={`Toggle ${props.name}`}
      />
    </div>
  );
}

type BindHostMode = "localhost" | "all" | "custom";
type PortMode = "random" | "fixed";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function ConfigurableBindUrlControls() {
  const enabled = useExperimentValue(EXPERIMENT_IDS.CONFIGURABLE_BIND_URL);
  const { api } = useAPI();

  const [status, setStatus] = useState<ApiServerStatus | null>(null);
  const [hostMode, setHostMode] = useState<BindHostMode>("localhost");
  const [customHost, setCustomHost] = useState<string>("");
  const [serveWebUi, setServeWebUi] = useState(false);
  const [portMode, setPortMode] = useState<PortMode>("random");
  const [fixedPort, setFixedPort] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const syncFormFromStatus = useCallback((next: ApiServerStatus) => {
    const configuredHost = next.configuredBindHost;

    if (!configuredHost || configuredHost === "127.0.0.1" || configuredHost === "localhost") {
      setHostMode("localhost");
      setCustomHost("");
    } else if (configuredHost === "0.0.0.0") {
      setHostMode("all");
      setCustomHost("");
    } else {
      setHostMode("custom");
      setCustomHost(configuredHost);
    }

    setServeWebUi(next.configuredServeWebUi);
    const configuredPort = next.configuredPort;
    if (!configuredPort) {
      setPortMode("random");
      setFixedPort("");
    } else {
      setPortMode("fixed");
      setFixedPort(String(configuredPort));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    if (!api) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setError(null);

    try {
      const next = await api.server.getApiServerStatus();
      if (requestIdRef.current !== requestId) {
        return;
      }

      setStatus(next);
      syncFormFromStatus(next);
    } catch (e) {
      if (requestIdRef.current !== requestId) {
        return;
      }

      setError(getErrorMessage(e));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [api, syncFormFromStatus]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    loadStatus().catch(() => {
      // loadStatus handles error state
    });
  }, [enabled, loadStatus]);

  const handleApply = useCallback(async () => {
    if (!api) {
      return;
    }

    setError(null);

    let bindHost: string | null;
    if (hostMode === "localhost") {
      bindHost = null;
    } else if (hostMode === "all") {
      bindHost = "0.0.0.0";
    } else {
      const trimmed = customHost.trim();
      if (!trimmed) {
        setError("Custom bind host is required.");
        return;
      }
      bindHost = trimmed;
    }

    let port: number | null;
    if (portMode === "random") {
      port = null;
    } else {
      const parsed = Number.parseInt(fixedPort, 10);

      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        setError("Port must be an integer.");
        return;
      }

      if (parsed === 0) {
        setError("Port 0 means random. Choose “Random” instead.");
        return;
      }

      if (parsed < 1 || parsed > 65535) {
        setError("Port must be between 1 and 65535.");
        return;
      }

      port = parsed;
    }

    setSaving(true);

    try {
      const next = await api.server.setApiServerSettings({
        bindHost,
        port,
        serveWebUi: serveWebUi ? true : null,
      });
      setStatus(next);
      syncFormFromStatus(next);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [api, hostMode, portMode, customHost, fixedPort, serveWebUi, syncFormFromStatus]);

  if (!enabled) {
    return null;
  }

  if (!api) {
    return (
      <div className="bg-background-secondary px-4 py-3">
        <div className="text-muted text-xs">Connect to mux to configure this setting.</div>
      </div>
    );
  }

  const encodedToken = status?.token ? encodeURIComponent(status.token) : null;
  const localWebUiUrl = status?.baseUrl ? `${status.baseUrl}/` : null;
  const localWebUiUrlWithToken =
    status?.baseUrl && encodedToken ? `${status.baseUrl}/?token=${encodedToken}` : null;
  const networkWebUiUrls = status?.networkBaseUrls.map((baseUrl) => `${baseUrl}/`) ?? [];
  const networkWebUiUrlsWithToken = encodedToken
    ? (status?.networkBaseUrls.map((baseUrl) => `${baseUrl}/?token=${encodedToken}`) ?? [])
    : [];
  const localDocsUrl = status?.baseUrl ? `${status.baseUrl}/api/docs` : null;
  const networkDocsUrls = status?.networkBaseUrls.map((baseUrl) => `${baseUrl}/api/docs`) ?? [];

  return (
    <div className="bg-background-secondary space-y-4 px-4 py-3">
      <div className="text-warning text-xs">
        Exposes mux’s API server to your LAN/VPN. Devices on your local network can connect if they
        have the auth token. Traffic is unencrypted HTTP; enable only on trusted networks (Tailscale
        recommended).
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-foreground text-sm">Bind host</div>
            <div className="text-muted text-xs">Where mux listens for HTTP + WS connections</div>
          </div>
          <Select value={hostMode} onValueChange={(value) => setHostMode(value as BindHostMode)}>
            <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-64 cursor-pointer rounded-md border px-3 text-sm transition-colors">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="localhost">Localhost only (127.0.0.1)</SelectItem>
              <SelectItem value="all">All interfaces (0.0.0.0)</SelectItem>
              <SelectItem value="custom">Custom…</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {hostMode === "custom" && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-foreground text-sm">Custom host</div>
              <div className="text-muted text-xs">Example: 192.168.1.10 or 100.x.y.z</div>
            </div>
            <Input
              value={customHost}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCustomHost(e.target.value)}
              placeholder="e.g. 192.168.1.10"
              className="border-border-medium bg-background-secondary h-9 w-64"
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-foreground text-sm">Port</div>
            <div className="text-muted text-xs">
              Use a fixed port to avoid changing URLs each time mux restarts
            </div>
          </div>
          <Select value={portMode} onValueChange={(value) => setPortMode(value as PortMode)}>
            <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-64 cursor-pointer rounded-md border px-3 text-sm transition-colors">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="random">Random (changes on restart)</SelectItem>
              <SelectItem value="fixed">Fixed…</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {portMode === "fixed" && (
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-foreground text-sm">Fixed port</div>
              <div className="text-muted text-xs">1–65535</div>
            </div>
            <Input
              value={fixedPort}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFixedPort(e.target.value)}
              placeholder="e.g. 9999"
              className="border-border-medium bg-background-secondary h-9 w-64"
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-foreground text-sm">Serve mux web UI</div>
            <div className="text-muted text-xs">
              Serve the mux web interface at / (browser mode)
            </div>
          </div>
          <Switch
            checked={serveWebUi}
            onCheckedChange={(value) => setServeWebUi(value)}
            aria-label="Toggle serving mux web UI"
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-muted text-xs">
            {loading
              ? "Loading server status…"
              : status?.running
                ? "Server is running"
                : "Server is not running"}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                loadStatus().catch((e) => {
                  setError(getErrorMessage(e));
                });
              }}
              disabled={loading || saving}
            >
              Refresh
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                handleApply().catch((e) => {
                  setError(getErrorMessage(e));
                });
              }}
              disabled={loading || saving}
            >
              {saving ? "Applying…" : "Apply"}
            </Button>
          </div>
        </div>

        {error && <div className="text-error text-xs">{error}</div>}
      </div>

      {status && (
        <div className="space-y-2">
          <div className="text-foreground text-sm font-medium">Connection info</div>

          {localDocsUrl && (
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="text-muted text-xs">Local docs URL</div>
                <div className="font-mono text-xs break-all">{localDocsUrl}</div>
              </div>
              <CopyButton text={localDocsUrl} />
            </div>
          )}

          {networkDocsUrls.length > 0 ? (
            <div className="space-y-2">
              {networkDocsUrls.map((docsUrl) => (
                <div key={docsUrl} className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="text-muted text-xs">Network docs URL</div>
                    <div className="font-mono text-xs break-all">{docsUrl}</div>
                  </div>
                  <CopyButton text={docsUrl} />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted text-xs">
              No network URLs detected (bind host may still be localhost).
            </div>
          )}

          {status.configuredServeWebUi ? (
            <>
              {(localWebUiUrlWithToken ?? localWebUiUrl) && (
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="text-muted text-xs">Local web UI URL</div>
                    <div className="font-mono text-xs break-all">
                      {localWebUiUrlWithToken ?? localWebUiUrl}
                    </div>
                  </div>
                  <CopyButton text={localWebUiUrlWithToken ?? localWebUiUrl ?? ""} />
                </div>
              )}

              {(encodedToken ? networkWebUiUrlsWithToken : networkWebUiUrls).length > 0 ? (
                <div className="space-y-2">
                  {(encodedToken ? networkWebUiUrlsWithToken : networkWebUiUrls).map((uiUrl) => (
                    <div key={uiUrl} className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="text-muted text-xs">Network web UI URL</div>
                        <div className="font-mono text-xs break-all">{uiUrl}</div>
                      </div>
                      <CopyButton text={uiUrl} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-muted text-xs">
                  No network URLs detected for the web UI (bind host may still be localhost).
                </div>
              )}
            </>
          ) : (
            <div className="text-muted text-xs">
              Web UI serving is disabled (enable “Serve mux web UI” and Apply to access /).
            </div>
          )}

          {status.token && (
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="text-muted text-xs">Auth token</div>
                <div className="font-mono text-xs break-all">{status.token}</div>
              </div>
              <CopyButton text={status.token} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatsTabRow() {
  const { statsTabState, setStatsTabEnabled } = useFeatureFlags();

  const handleToggle = useCallback(
    (enabled: boolean) => {
      setStatsTabEnabled(enabled).catch(() => {
        // ignore
      });
    },
    [setStatsTabEnabled]
  );

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-foreground text-sm font-medium">Stats tab</div>
        <div className="text-muted mt-0.5 text-xs">Show timing statistics in the right sidebar</div>
      </div>
      <Switch
        checked={statsTabState?.enabled ?? false}
        onCheckedChange={handleToggle}
        aria-label="Toggle Stats tab"
      />
    </div>
  );
}

export function ExperimentsSection() {
  const allExperiments = getExperimentList();
  const { refreshWorkspaceMetadata } = useWorkspaceContext();
  const { api } = useAPI();

  // Only show user-overridable experiments (non-overridable ones are hidden since users can't change them)
  const experiments = useMemo(
    () =>
      allExperiments.filter((exp) => exp.showInSettings !== false && exp.userOverridable === true),
    [allExperiments]
  );

  // When post-compaction experiment is toggled, refresh metadata to fetch/clear bundled state
  const handlePostCompactionToggle = useCallback(() => {
    refreshWorkspaceMetadata().catch(() => {
      // ignore
    });
  }, [refreshWorkspaceMetadata]);

  const handleConfigurableBindUrlToggle = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        return;
      }

      api?.server
        .setApiServerSettings({ bindHost: null, port: null, serveWebUi: null })
        .catch(() => {
          // ignore
        });
    },
    [api]
  );

  return (
    <div className="space-y-2">
      <p className="text-muted mb-4 text-xs">
        Experimental features that are still in development. Enable at your own risk.
      </p>
      <div className="divide-border-light divide-y">
        <StatsTabRow />
        {experiments.map((exp) => (
          <React.Fragment key={exp.id}>
            <ExperimentRow
              experimentId={exp.id}
              name={exp.name}
              description={exp.description}
              onToggle={
                exp.id === EXPERIMENT_IDS.POST_COMPACTION_CONTEXT
                  ? handlePostCompactionToggle
                  : exp.id === EXPERIMENT_IDS.CONFIGURABLE_BIND_URL
                    ? handleConfigurableBindUrlToggle
                    : undefined
              }
            />
            {exp.id === EXPERIMENT_IDS.CONFIGURABLE_BIND_URL && <ConfigurableBindUrlControls />}
          </React.Fragment>
        ))}
      </div>
      {experiments.length === 0 && (
        <p className="text-muted py-4 text-center text-sm">
          No experiments available at this time.
        </p>
      )}
    </div>
  );
}
