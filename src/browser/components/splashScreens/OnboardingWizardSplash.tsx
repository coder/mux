import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, Boxes, Command as CommandIcon, Server, Sparkles } from "lucide-react";
import { SplashScreen } from "./SplashScreen";
import { DocsLink } from "@/browser/components/DocsLink";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon";
import {
  CoderIcon,
  DockerIcon,
  LocalIcon,
  SSHIcon,
  WorktreeIcon,
} from "@/browser/components/icons/RuntimeIcons";
import { Button } from "@/browser/components/ui/button";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { getStoredAuthToken } from "@/browser/components/AuthTokenModal";
import { useAPI } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getEligibleGatewayModels } from "@/browser/utils/gatewayModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { PROVIDER_DISPLAY_NAMES, SUPPORTED_PROVIDERS } from "@/common/constants/providers";

interface OAuthMessage {
  type?: unknown;
  state?: unknown;
  ok?: unknown;
  error?: unknown;
}

type MuxGatewayLoginStatus = "idle" | "starting" | "waiting" | "success" | "error";

function getServerAuthToken(): string | null {
  const urlToken = new URLSearchParams(window.location.search).get("token")?.trim();
  return urlToken?.length ? urlToken : getStoredAuthToken();
}

function getBackendBaseUrl(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  return import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
}

const GATEWAY_MODELS_KEY = "gateway-models";
const KBD_CLASSNAME =
  "bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-xs";

interface WizardStep {
  key: string;
  title: string;
  icon: React.ReactNode;
  body: React.ReactNode;
}
type Direction = "forward" | "back";

function ProgressDots(props: { count: number; activeIndex: number }) {
  return (
    <div
      className="flex items-center gap-1"
      aria-label={`Step ${props.activeIndex + 1} of ${props.count}`}
    >
      {Array.from({ length: props.count }).map((_, i) => (
        <span
          key={`dot-${i}`}
          className={`h-1.5 w-1.5 rounded-full ${
            i === props.activeIndex ? "bg-accent" : "bg-border-medium"
          }`}
        />
      ))}
    </div>
  );
}

function WizardHeader(props: { stepIndex: number; totalSteps: number }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-muted text-xs">
        {props.stepIndex + 1} / {props.totalSteps}
      </span>
      <ProgressDots count={props.totalSteps} activeIndex={props.stepIndex} />
    </div>
  );
}

function Card(props: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-background-secondary border-border-medium rounded-lg border p-3 ${
        props.className ?? ""
      }`}
    >
      <div className="text-foreground flex items-center gap-2 text-sm font-medium">
        <span className="bg-accent/10 text-accent inline-flex h-7 w-7 items-center justify-center rounded-md">
          {props.icon}
        </span>
        {props.title}
      </div>
      <div className="text-muted mt-2 text-sm">{props.children}</div>
    </div>
  );
}

function CommandPalettePreview(props: { shortcut: string }) {
  return (
    <div
      className="font-primary overflow-hidden rounded-lg border border-[var(--color-command-border)] bg-[var(--color-command-surface)] text-[var(--color-command-foreground)]"
      aria-label="Command palette preview"
    >
      <div className="border-b border-[var(--color-command-input-border)] bg-[var(--color-command-input)] px-3.5 py-3 text-sm">
        <span className="text-[var(--color-command-subdued)]">
          Switch workspaces or type <span className="font-mono">&gt;</span> for all commands…
        </span>
      </div>

      <div className="px-1.5 py-2">
        <div className="px-2.5 py-1 text-[11px] tracking-[0.08em] text-[var(--color-command-subdued)] uppercase">
          Recent
        </div>

        <div className="hover:bg-hover mx-1 my-0.5 grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-3 py-2 text-[13px]">
          <div>
            Create New Workspace…
            <br />
            <span className="text-xs text-[var(--color-command-subdued)]">
              Start a new workspace (Local / Worktree / SSH / Docker)
            </span>
          </div>
          <span className="font-monospace text-[11px] text-[var(--color-command-subdued)]">
            &gt;new
          </span>
        </div>

        <div className="bg-hover mx-1 my-0.5 grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-3 py-2 text-[13px]">
          <div>
            Open Settings…
            <br />
            <span className="text-xs text-[var(--color-command-subdued)]">
              Jump to providers, models, MCP…
            </span>
          </div>
          <span className="font-monospace text-[11px] text-[var(--color-command-subdued)]">
            &gt;settings
          </span>
        </div>

        <div className="hover:bg-hover mx-1 my-0.5 grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-3 py-2 text-[13px]">
          <div>
            Help: Keybinds
            <br />
            <span className="text-xs text-[var(--color-command-subdued)]">
              Discover shortcuts for the whole app
            </span>
          </div>
          <span className="font-monospace text-[11px] text-[var(--color-command-subdued)]">
            {props.shortcut}
          </span>
        </div>
      </div>
    </div>
  );
}

export function OnboardingWizardSplash(props: { onDismiss: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);

  const { open: openSettings } = useSettings();
  const { config: providersConfig, loading: providersLoading } = useProvidersConfig();
  const [direction, setDirection] = useState<Direction>("forward");

  const { api } = useAPI();

  const backendBaseUrl = getBackendBaseUrl();
  const backendOrigin = useMemo(() => {
    try {
      return new URL(backendBaseUrl).origin;
    } catch {
      return window.location.origin;
    }
  }, [backendBaseUrl]);

  const isDesktop = !!window.api;

  const [muxGatewayLoginStatus, setMuxGatewayLoginStatus] = useState<MuxGatewayLoginStatus>("idle");
  const [muxGatewayLoginError, setMuxGatewayLoginError] = useState<string | null>(null);

  const muxGatewayApplyDefaultModelsOnSuccessRef = useRef(false);
  const muxGatewayLoginAttemptRef = useRef(0);
  const [muxGatewayDesktopFlowId, setMuxGatewayDesktopFlowId] = useState<string | null>(null);
  const [muxGatewayServerState, setMuxGatewayServerState] = useState<string | null>(null);

  const cancelMuxGatewayLogin = useCallback(() => {
    muxGatewayApplyDefaultModelsOnSuccessRef.current = false;
    muxGatewayLoginAttemptRef.current++;

    if (isDesktop && api && muxGatewayDesktopFlowId) {
      void api.muxGatewayOauth.cancelDesktopFlow({ flowId: muxGatewayDesktopFlowId });
    }

    setMuxGatewayDesktopFlowId(null);
    setMuxGatewayServerState(null);
    setMuxGatewayLoginStatus("idle");
    setMuxGatewayLoginError(null);
  }, [api, isDesktop, muxGatewayDesktopFlowId]);

  const startMuxGatewayLogin = useCallback(async () => {
    const attempt = ++muxGatewayLoginAttemptRef.current;

    // Enable Mux Gateway for all eligible models after the *first* successful login.
    const isLoggedIn = providersConfig?.["mux-gateway"]?.couponCodeSet ?? false;
    muxGatewayApplyDefaultModelsOnSuccessRef.current = !isLoggedIn;

    try {
      setMuxGatewayLoginError(null);
      setMuxGatewayDesktopFlowId(null);
      setMuxGatewayServerState(null);

      if (isDesktop) {
        if (!api) {
          setMuxGatewayLoginStatus("error");
          setMuxGatewayLoginError("Mux API not connected.");
          return;
        }

        setMuxGatewayLoginStatus("starting");
        const startResult = await api.muxGatewayOauth.startDesktopFlow();

        if (attempt !== muxGatewayLoginAttemptRef.current) {
          if (startResult.success) {
            void api.muxGatewayOauth.cancelDesktopFlow({ flowId: startResult.data.flowId });
          }
          return;
        }

        if (!startResult.success) {
          setMuxGatewayLoginStatus("error");
          setMuxGatewayLoginError(startResult.error);
          return;
        }

        const { flowId, authorizeUrl } = startResult.data;
        setMuxGatewayDesktopFlowId(flowId);
        setMuxGatewayLoginStatus("waiting");

        // Desktop main process intercepts external window.open() calls and routes them via shell.openExternal.
        window.open(authorizeUrl, "_blank", "noopener");

        if (attempt !== muxGatewayLoginAttemptRef.current) {
          return;
        }

        const waitResult = await api.muxGatewayOauth.waitForDesktopFlow({ flowId });

        if (attempt !== muxGatewayLoginAttemptRef.current) {
          return;
        }

        if (waitResult.success) {
          if (muxGatewayApplyDefaultModelsOnSuccessRef.current) {
            let latestConfig: ProvidersConfigMap | null = providersConfig;
            try {
              latestConfig = await api.providers.getConfig();
            } catch {
              // Ignore errors fetching config; fall back to the current snapshot.
            }

            if (attempt !== muxGatewayLoginAttemptRef.current) {
              return;
            }

            updatePersistedState(GATEWAY_MODELS_KEY, getEligibleGatewayModels(latestConfig));
            muxGatewayApplyDefaultModelsOnSuccessRef.current = false;
          }

          setMuxGatewayLoginStatus("success");
          return;
        }

        setMuxGatewayLoginStatus("error");
        setMuxGatewayLoginError(waitResult.error);
        return;
      }

      // Browser/server mode: use unauthenticated bootstrap route.
      // Open popup synchronously to preserve user gesture context (avoids popup blockers).
      const popup = window.open("about:blank", "_blank");
      if (!popup) {
        throw new Error("Popup blocked - please allow popups and try again.");
      }

      setMuxGatewayLoginStatus("starting");

      const startUrl = new URL("/auth/mux-gateway/start", backendBaseUrl);
      const authToken = getServerAuthToken();

      let json: { authorizeUrl?: unknown; state?: unknown; error?: unknown };
      try {
        const res = await fetch(startUrl, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        });

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const body = await res.text();
          const prefix = body.trim().slice(0, 80);
          throw new Error(
            `Unexpected response from ${startUrl.toString()} (expected JSON, got ${
              contentType || "unknown"
            }): ${prefix}`
          );
        }

        json = (await res.json()) as typeof json;

        if (!res.ok) {
          const message = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
          throw new Error(message);
        }
      } catch (err) {
        popup.close();
        throw err;
      }

      if (attempt !== muxGatewayLoginAttemptRef.current) {
        popup.close();
        return;
      }

      if (typeof json.authorizeUrl !== "string" || typeof json.state !== "string") {
        popup.close();
        throw new Error(`Invalid response from ${startUrl.pathname}`);
      }

      setMuxGatewayServerState(json.state);
      popup.location.href = json.authorizeUrl;
      setMuxGatewayLoginStatus("waiting");
    } catch (err) {
      if (attempt !== muxGatewayLoginAttemptRef.current) {
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      setMuxGatewayLoginStatus("error");
      setMuxGatewayLoginError(message);
    }
  }, [api, backendBaseUrl, isDesktop, providersConfig]);

  useEffect(() => {
    const attempt = muxGatewayLoginAttemptRef.current;

    if (isDesktop || muxGatewayLoginStatus !== "waiting" || !muxGatewayServerState) {
      return;
    }

    const handleMessage = (event: MessageEvent<OAuthMessage>) => {
      if (event.origin !== backendOrigin) return;
      if (muxGatewayLoginAttemptRef.current !== attempt) return;

      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type !== "mux-gateway-oauth") return;
      if (data.state !== muxGatewayServerState) return;

      if (data.ok === true) {
        if (muxGatewayApplyDefaultModelsOnSuccessRef.current) {
          muxGatewayApplyDefaultModelsOnSuccessRef.current = false;

          const applyLatest = (latestConfig: ProvidersConfigMap | null) => {
            if (muxGatewayLoginAttemptRef.current !== attempt) return;
            updatePersistedState(GATEWAY_MODELS_KEY, getEligibleGatewayModels(latestConfig));
          };

          if (api) {
            api.providers
              .getConfig()
              .then(applyLatest)
              .catch(() => applyLatest(providersConfig));
          } else {
            applyLatest(providersConfig);
          }
        }

        setMuxGatewayLoginStatus("success");
        return;
      }

      const msg = typeof data.error === "string" ? data.error : "Login failed";
      setMuxGatewayLoginStatus("error");
      setMuxGatewayLoginError(msg);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    api,
    backendOrigin,
    isDesktop,
    muxGatewayLoginStatus,
    muxGatewayServerState,
    providersConfig,
  ]);

  const muxGatewayCouponCodeSet = providersConfig?.["mux-gateway"]?.couponCodeSet ?? false;
  const muxGatewayLoginInProgress =
    muxGatewayLoginStatus === "waiting" || muxGatewayLoginStatus === "starting";
  const muxGatewayIsLoggedIn = muxGatewayCouponCodeSet || muxGatewayLoginStatus === "success";

  const muxGatewayLoginButtonLabel =
    muxGatewayLoginStatus === "error"
      ? "Try again"
      : muxGatewayLoginInProgress
        ? "Waiting for login..."
        : muxGatewayIsLoggedIn
          ? "Re-login to Mux Gateway"
          : "Login with Mux Gateway";

  const configuredProviders = useMemo(
    () =>
      SUPPORTED_PROVIDERS.filter((provider) => providersConfig?.[provider]?.isConfigured === true),
    [providersConfig]
  );

  const configuredProvidersSummary = useMemo(() => {
    if (configuredProviders.length === 0) {
      return null;
    }

    return configuredProviders.map((p) => PROVIDER_DISPLAY_NAMES[p]).join(", ");
  }, [configuredProviders]);

  const [hasConfiguredProvidersAtStart, setHasConfiguredProvidersAtStart] = useState<
    boolean | null
  >(null);

  useEffect(() => {
    if (hasConfiguredProvidersAtStart !== null) {
      return;
    }

    if (providersLoading) {
      return;
    }

    setHasConfiguredProvidersAtStart(configuredProviders.length > 0);
  }, [configuredProviders.length, hasConfiguredProvidersAtStart, providersLoading]);

  const commandPaletteShortcut = formatKeybind(KEYBINDS.OPEN_COMMAND_PALETTE);
  const agentPickerShortcut = formatKeybind(KEYBINDS.TOGGLE_MODE);
  const cycleAgentShortcut = formatKeybind(KEYBINDS.CYCLE_AGENT);

  const steps = useMemo((): WizardStep[] => {
    if (hasConfiguredProvidersAtStart === null) {
      return [
        {
          key: "loading",
          title: "Getting started",
          icon: <Sparkles className="h-4 w-4" />,
          body: (
            <>
              <p>Checking your provider configuration…</p>
            </>
          ),
        },
      ];
    }

    const nextSteps: WizardStep[] = [];

    if (hasConfiguredProvidersAtStart === false) {
      nextSteps.push({
        key: "mux-gateway",
        title: "Mux Gateway (evaluation credits)",
        icon: <Sparkles className="h-4 w-4" />,
        body: (
          <>
            <p>
              Mux Gateway enables you to use free AI tokens from{" "}
              <a
                href="https://coder.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Coder
              </a>
              .
            </p>

            <p>
              OSS contributors with GitHub accounts older than 12 months (or GitHub Pro members) can
              use this to get free evaluation credits.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  void startMuxGatewayLogin();
                }}
                disabled={muxGatewayLoginInProgress}
              >
                {muxGatewayLoginButtonLabel}
              </Button>

              {muxGatewayLoginInProgress && (
                <Button variant="secondary" onClick={cancelMuxGatewayLogin}>
                  Cancel
                </Button>
              )}
            </div>

            {muxGatewayLoginStatus === "success" && <p className="mt-3">Login successful.</p>}

            {muxGatewayLoginStatus === "waiting" && (
              <p className="mt-3">Finish the login flow in your browser, then return here.</p>
            )}

            {muxGatewayLoginStatus === "error" && muxGatewayLoginError && (
              <p className="mt-3">
                <strong className="text-destructive">Login failed:</strong> {muxGatewayLoginError}
              </p>
            )}

            <p className="mt-3">You can also receive those credits through:</p>

            <ul className="ml-4 list-disc space-y-1">
              <li>
                early adopters can request credits tied to their GH logins on our{" "}
                <a
                  href="https://discord.gg/VfZXvtnR"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Discord
                </a>
              </li>
              <li>
                vouchers which you can{" "}
                <a
                  href="https://gateway.mux.coder.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  claim here
                </a>
              </li>
            </ul>

            <p className="mt-3">
              You can enable this in{" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => openSettings("providers")}
              >
                Settings → Providers
              </button>
              .
            </p>
          </>
        ),
      });
    }

    nextSteps.push({
      key: "providers",
      title: "Choose your own AI providers",
      icon: <Sparkles className="h-4 w-4" />,
      body: (
        <>
          <p>
            Mux is provider-agnostic: bring your own keys, mix and match models, or run locally.
          </p>

          {configuredProviders.length > 0 && configuredProvidersSummary ? (
            <p className="mt-3 text-xs">
              <span className="text-foreground font-medium">Configured:</span>{" "}
              {configuredProvidersSummary}
            </p>
          ) : (
            <p className="mt-3 text-xs">No providers configured yet.</p>
          )}

          <div className="mt-3">
            <div className="text-foreground mb-2 text-xs font-medium">Available providers</div>
            <div className="grid grid-cols-2 gap-2">
              {SUPPORTED_PROVIDERS.map((provider) => {
                const configured = providersConfig?.[provider]?.isConfigured === true;

                return (
                  <button
                    key={provider}
                    type="button"
                    className="bg-background-secondary border-border-medium text-foreground hover:bg-hover flex w-full cursor-pointer items-center justify-between rounded-md border px-2 py-1 text-left text-xs"
                    title={configured ? "Configured" : "Not configured"}
                    onClick={() => openSettings("providers", { expandProvider: provider })}
                  >
                    <ProviderWithIcon provider={provider} displayName iconClassName="text-accent" />
                    <span
                      className={`h-2 w-2 rounded-full ${
                        configured ? "bg-green-500" : "bg-border-medium"
                      }`}
                    />
                  </button>
                );
              })}
            </div>

            <div className="text-muted mt-2 flex items-center gap-2 text-xs">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span>Configured</span>
              <span className="bg-border-medium h-2 w-2 rounded-full" />
              <span>Not configured</span>
            </div>
          </div>

          <p className="mt-3">
            Configure keys and endpoints in{" "}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => openSettings("providers")}
            >
              Settings → Providers
            </button>
            .
          </p>
        </>
      ),
    });

    nextSteps.push({
      key: "agents",
      title: "Agents: Plan, Exec, and custom",
      icon: <Bot className="h-4 w-4" />,
      body: (
        <>
          <p>
            Agents are file-based definitions (system prompt + tool policy). You can create
            project-local agents in <code className="text-accent">.mux/agents/*.md</code> or global
            agents in <code className="text-accent">~/.mux/agents/*.md</code>.
          </p>

          <div className="mt-3 grid gap-2">
            <Card icon={<Sparkles className="h-4 w-4" />} title="Use Plan to design the spec">
              When the change is complex, switch to a plan-like agent first: write an explicit plan
              (files, steps, risks), then execute.
            </Card>

            <Card icon={<Bot className="h-4 w-4" />} title="Quick shortcuts">
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span>Agent picker</span>
                <kbd className={KBD_CLASSNAME}>{agentPickerShortcut}</kbd>
                <span className="text-muted mx-1">•</span>
                <span>Cycle agent</span>
                <kbd className={KBD_CLASSNAME}>{cycleAgentShortcut}</kbd>
              </div>
            </Card>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <DocsLink path="/agents">Agent docs</DocsLink>
            <DocsLink path="/agents/plan-mode">Plan mode</DocsLink>
          </div>
        </>
      ),
    });

    nextSteps.push({
      key: "runtimes",
      title: "Multiple runtimes",
      icon: <Boxes className="h-4 w-4" />,
      body: (
        <>
          <p>
            Each workspace can run in the environment that fits the job: keep it local, isolate with
            a git worktree, run remotely over SSH, or use a per-workspace Docker container.
          </p>

          <div className="mt-3 grid gap-2">
            <Card icon={<LocalIcon size={14} />} title="Local">
              Work directly in your project directory.
            </Card>
            <Card icon={<WorktreeIcon size={14} />} title="Worktree">
              Isolated git worktree under <code className="text-accent">~/.mux/src</code>.
            </Card>
            <Card icon={<SSHIcon size={14} />} title="SSH">
              Remote clone and commands run on an SSH host.
            </Card>
            <Card icon={<CoderIcon size={14} />} title="Coder (SSH)">
              Use Coder workspaces over SSH for a managed remote dev environment.
            </Card>
            <Card icon={<DockerIcon size={14} />} title="Docker">
              Isolated container per workspace.
            </Card>
          </div>

          <p className="mt-3">You can set a project default runtime in the workspace controls.</p>
        </>
      ),
    });

    nextSteps.push({
      key: "mcp",
      title: "MCP servers",
      icon: <Server className="h-4 w-4" />,
      body: (
        <>
          <p>
            MCP servers extend Mux with tools (memory, ticketing, databases, internal APIs).
            Configure them per project and optionally override per workspace.
          </p>

          <div className="mt-3 grid gap-2">
            <Card icon={<Server className="h-4 w-4" />} title="Project config">
              <code className="text-accent">.mux/mcp.jsonc</code>
            </Card>
            <Card icon={<Server className="h-4 w-4" />} title="Workspace overrides">
              <code className="text-accent">.mux/mcp.local.jsonc</code>
            </Card>
          </div>

          <p className="mt-3">
            Manage servers in <span className="text-foreground">Settings → Projects</span> or via{" "}
            <code className="text-accent">/mcp</code>.
          </p>
        </>
      ),
    });

    nextSteps.push({
      key: "palette",
      title: "Command palette",
      icon: <CommandIcon className="h-4 w-4" />,
      body: (
        <>
          <p>
            The command palette is the fastest way to navigate, create workspaces, and discover
            features.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-muted text-sm">Open command palette</span>
            <kbd className={KBD_CLASSNAME}>{commandPaletteShortcut}</kbd>
          </div>

          <div className="mt-3">
            <CommandPalettePreview shortcut={commandPaletteShortcut} />
          </div>

          <p className="mt-3">
            Tip: type <code className="text-accent">&gt;</code> for commands and{" "}
            <code className="text-accent">/</code> for slash commands.
          </p>
        </>
      ),
    });

    return nextSteps;
  }, [
    agentPickerShortcut,
    cancelMuxGatewayLogin,
    commandPaletteShortcut,
    configuredProviders.length,
    configuredProvidersSummary,
    cycleAgentShortcut,
    hasConfiguredProvidersAtStart,
    muxGatewayLoginButtonLabel,
    muxGatewayLoginError,
    muxGatewayLoginInProgress,
    muxGatewayLoginStatus,
    openSettings,
    providersConfig,
    startMuxGatewayLogin,
  ]);

  useEffect(() => {
    setStepIndex((index) => Math.min(index, steps.length - 1));
  }, [steps.length]);

  const totalSteps = steps.length;
  const currentStep = steps[stepIndex] ?? steps[0];

  useEffect(() => {
    if (currentStep?.key !== "mux-gateway" && muxGatewayLoginInProgress) {
      cancelMuxGatewayLogin();
    }
  }, [cancelMuxGatewayLogin, currentStep?.key, muxGatewayLoginInProgress]);

  if (!currentStep) {
    return null;
  }

  const isLoading = hasConfiguredProvidersAtStart === null;
  const canGoBack = !isLoading && stepIndex > 0;
  const canGoForward = !isLoading && stepIndex < totalSteps - 1;

  const goBack = () => {
    if (!canGoBack) {
      return;
    }
    setDirection("back");
    setStepIndex((i) => Math.max(0, i - 1));
  };

  const goForward = () => {
    if (!canGoForward) {
      return;
    }
    setDirection("forward");
    setStepIndex((i) => Math.min(totalSteps - 1, i + 1));
  };

  const primaryLabel = isLoading ? "Next" : canGoForward ? "Next" : "Done";

  return (
    <SplashScreen
      title={currentStep.title}
      onDismiss={() => {
        cancelMuxGatewayLogin();
        props.onDismiss();
      }}
      dismissLabel={null}
      footerClassName="justify-between"
      footer={
        <>
          <div>
            {canGoBack && (
              <Button variant="secondary" onClick={goBack} className="min-w-24">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button
              className="min-w-24"
              onClick={() => {
                if (isLoading) {
                  return;
                }

                if (canGoForward) {
                  goForward();
                  return;
                }

                props.onDismiss();
              }}
              disabled={isLoading}
            >
              {primaryLabel}
            </Button>

            <Button variant="secondary" onClick={props.onDismiss} className="min-w-24">
              Skip
            </Button>
          </div>
        </>
      }
    >
      <div className="text-muted flex flex-col gap-4">
        <WizardHeader stepIndex={stepIndex} totalSteps={totalSteps} />

        <div
          key={currentStep.key}
          className={`flex flex-col gap-3 ${
            direction === "forward"
              ? "animate-in fade-in-0 slide-in-from-right-2"
              : "animate-in fade-in-0 slide-in-from-left-2"
          }`}
        >
          <div className="text-foreground flex items-center gap-2 text-sm font-medium">
            <span className="bg-accent/10 text-accent inline-flex h-8 w-8 items-center justify-center rounded-md">
              {currentStep.icon}
            </span>
            <span>{currentStep.title}</span>
          </div>

          <div className="text-muted flex flex-col gap-3 text-sm">{currentStep.body}</div>
        </div>
      </div>
    </SplashScreen>
  );
}
