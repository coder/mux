import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  ShieldCheck,
  X,
} from "lucide-react";

import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { getBrowserBackendBaseUrl } from "@/browser/utils/backendBaseUrl";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { ProviderName } from "@/common/constants/providers";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { getAllowedProvidersForUi } from "@/browser/utils/policyUi";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import { getStoredAuthToken } from "@/browser/components/AuthTokenModal/AuthTokenModal";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import {
  formatMuxGatewayBalance,
  useMuxGatewayAccountStatus,
} from "@/browser/hooks/useMuxGatewayAccountStatus";
import { useGateway } from "@/browser/hooks/useGatewayModels";
import { getEligibleGatewayModels } from "@/browser/utils/gatewayModels";
import { Button } from "@/browser/components/Button/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Switch } from "@/browser/components/Switch/Switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/browser/components/ToggleGroupPrimitive/ToggleGroupPrimitive";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/browser/components/Tooltip/Tooltip";
import { getErrorMessage } from "@/common/utils/errors";

type MuxGatewayLoginStatus = "idle" | "starting" | "waiting" | "success" | "error";
type CodexOauthFlowStatus = "idle" | "starting" | "waiting" | "error";
type CopilotLoginStatus = "idle" | "starting" | "waiting" | "success" | "error";

interface CodexOauthDeviceFlow {
  flowId: string;
  userCode: string;
  verifyUrl: string;
}

interface OAuthMessage {
  type?: unknown;
  state?: unknown;
  ok?: unknown;
  error?: unknown;
}

function getServerAuthToken(): string | null {
  const urlToken = new URLSearchParams(window.location.search).get("token")?.trim();
  return urlToken?.length ? urlToken : getStoredAuthToken();
}

interface FieldConfig {
  key: string;
  label: string;
  placeholder: string;
  type: "secret" | "text";
  optional?: boolean;
}

/**
 * Get provider-specific field configuration.
 * Most providers use API Key + Base URL, but some (like Bedrock) have different needs.
 */
function getProviderFields(provider: ProviderName): FieldConfig[] {
  if (provider === "bedrock") {
    return [
      { key: "region", label: "Region", placeholder: "us-east-1", type: "text" },
      {
        key: "profile",
        label: "AWS Profile",
        placeholder: "my-sso-profile",
        type: "text",
        optional: true,
      },
      {
        key: "bearerToken",
        label: "Bearer Token",
        placeholder: "AWS_BEARER_TOKEN_BEDROCK",
        type: "secret",
        optional: true,
      },
      {
        key: "accessKeyId",
        label: "Access Key ID",
        placeholder: "AWS Access Key ID",
        type: "secret",
        optional: true,
      },
      {
        key: "secretAccessKey",
        label: "Secret Access Key",
        placeholder: "AWS Secret Access Key",
        type: "secret",
        optional: true,
      },
    ];
  }

  if (provider === "mux-gateway") {
    return [];
  }

  if (provider === "github-copilot") {
    return []; // OAuth-based, no manual key entry
  }

  // Default for most providers
  return [
    { key: "apiKey", label: "API Key", placeholder: "Enter API key", type: "secret" },
    {
      key: "baseUrl",
      label: "Base URL",
      placeholder: "https://api.example.com",
      type: "text",
      optional: true,
    },
  ];
}

/**
 * URLs to create/manage API keys for each provider.
 */
const PROVIDER_KEY_URLS: Partial<Record<ProviderName, string>> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  google: "https://aistudio.google.com/app/apikey",
  xai: "https://console.x.ai/team/default/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  openrouter: "https://openrouter.ai/settings/keys",
  // bedrock: AWS credential chain, no simple key URL
  // ollama: local service, no key needed
};

export function ProvidersSection() {
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;
  const visibleProviders = useMemo(
    () => getAllowedProvidersForUi(effectivePolicy),
    [effectivePolicy]
  );

  const { providersExpandedProvider, setProvidersExpandedProvider } = useSettings();

  const { api } = useAPI();
  const { config, refresh, updateOptimistically } = useProvidersConfig();
  const {
    data: muxGatewayAccountStatus,
    error: muxGatewayAccountError,
    isLoading: muxGatewayAccountLoading,
    refresh: refreshMuxGatewayAccountStatus,
  } = useMuxGatewayAccountStatus();

  const gateway = useGateway();

  const eligibleGatewayModels = useMemo(() => getEligibleGatewayModels(config), [config]);

  const canEnableGatewayForAllModels = useMemo(
    () =>
      eligibleGatewayModels.length > 0 &&
      !eligibleGatewayModels.every((modelId) => gateway.enabledModels.includes(modelId)),
    [eligibleGatewayModels, gateway.enabledModels]
  );

  const enableGatewayForAllModels = useCallback(() => {
    if (!canEnableGatewayForAllModels) {
      return;
    }

    // Keep gateway model writes centralized in useGateway so this action and the
    // global gateway toggle persist from the same config snapshot.
    gateway.setEnabledModels(eligibleGatewayModels);
  }, [canEnableGatewayForAllModels, eligibleGatewayModels, gateway]);

  const backendBaseUrl = getBrowserBackendBaseUrl();
  const backendOrigin = (() => {
    try {
      return new URL(backendBaseUrl).origin;
    } catch {
      return window.location.origin;
    }
  })();

  const isDesktop = !!window.api;

  // The "Connect (Browser)" OAuth flow requires a redirect back to this origin,
  // which only works when the host is the user's local machine. On a remote mux
  // server the redirect would land on the server, not the user's browser.
  const isRemoteServer =
    !isDesktop && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

  const [codexOauthStatus, setCodexOauthStatus] = useState<CodexOauthFlowStatus>("idle");
  const [codexOauthError, setCodexOauthError] = useState<string | null>(null);

  const codexOauthAttemptRef = useRef(0);
  const [codexOauthDesktopFlowId, setCodexOauthDesktopFlowId] = useState<string | null>(null);
  const [codexOauthDeviceFlow, setCodexOauthDeviceFlow] = useState<CodexOauthDeviceFlow | null>(
    null
  );
  const [codexOauthAuthorizeUrl, setCodexOauthAuthorizeUrl] = useState<string | null>(null);

  const codexOauthIsConnected = config?.openai?.codexOauthSet === true;
  const openaiApiKeySet = config?.openai?.apiKeySet === true;
  const codexOauthDefaultAuth =
    config?.openai?.codexOauthDefaultAuth === "apiKey" ? "apiKey" : "oauth";
  const codexOauthDefaultAuthIsEditable = codexOauthIsConnected && openaiApiKeySet;

  const codexOauthLoginInProgress =
    codexOauthStatus === "starting" || codexOauthStatus === "waiting";

  const startCodexOauthBrowserConnect = async () => {
    const attempt = ++codexOauthAttemptRef.current;

    if (!api) {
      setCodexOauthStatus("error");
      setCodexOauthError("Mux API not connected.");
      return;
    }

    // Best-effort: cancel any in-progress flow before starting a new one.
    if (codexOauthDesktopFlowId) {
      void api.codexOauth.cancelDesktopFlow({ flowId: codexOauthDesktopFlowId });
    }
    if (codexOauthDeviceFlow) {
      void api.codexOauth.cancelDeviceFlow({ flowId: codexOauthDeviceFlow.flowId });
    }

    setCodexOauthError(null);
    setCodexOauthDesktopFlowId(null);
    setCodexOauthDeviceFlow(null);
    setCodexOauthAuthorizeUrl(null);

    try {
      setCodexOauthStatus("starting");

      if (!isDesktop) {
        const startResult = await api.codexOauth.startDeviceFlow();

        if (attempt !== codexOauthAttemptRef.current) {
          if (startResult.success) {
            void api.codexOauth.cancelDeviceFlow({ flowId: startResult.data.flowId });
          }
          return;
        }

        if (!startResult.success) {
          setCodexOauthStatus("error");
          setCodexOauthError(startResult.error);
          return;
        }

        setCodexOauthDeviceFlow({
          flowId: startResult.data.flowId,
          userCode: startResult.data.userCode,
          verifyUrl: startResult.data.verifyUrl,
        });
        setCodexOauthStatus("waiting");

        // Keep device-code login manual per user request: we only open the
        // verification page from the explicit "Copy & Open" action.
        const waitResult = await api.codexOauth.waitForDeviceFlow({
          flowId: startResult.data.flowId,
        });

        if (attempt !== codexOauthAttemptRef.current) {
          return;
        }

        if (!waitResult.success) {
          setCodexOauthStatus("error");
          setCodexOauthError(waitResult.error);
          return;
        }

        setCodexOauthStatus("idle");
        setCodexOauthDeviceFlow(null);
        setCodexOauthAuthorizeUrl(null);
        await refresh();
        return;
      }

      const startResult = await api.codexOauth.startDesktopFlow();

      if (attempt !== codexOauthAttemptRef.current) {
        if (startResult.success) {
          void api.codexOauth.cancelDesktopFlow({ flowId: startResult.data.flowId });
        }
        return;
      }

      if (!startResult.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(startResult.error);
        return;
      }

      const { flowId, authorizeUrl } = startResult.data;
      setCodexOauthDesktopFlowId(flowId);
      setCodexOauthAuthorizeUrl(authorizeUrl);
      setCodexOauthStatus("waiting");

      const waitResult = await api.codexOauth.waitForDesktopFlow({ flowId });

      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      if (!waitResult.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(waitResult.error);
        return;
      }

      setCodexOauthStatus("idle");
      setCodexOauthDesktopFlowId(null);
      await refresh();
    } catch (err) {
      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      setCodexOauthStatus("error");
      setCodexOauthError(getErrorMessage(err));
    }
  };

  const startCodexOauthDeviceConnect = async () => {
    const attempt = ++codexOauthAttemptRef.current;

    if (!api) {
      setCodexOauthStatus("error");
      setCodexOauthError("Mux API not connected.");
      return;
    }

    // Best-effort: cancel any in-progress flow before starting a new one.
    if (codexOauthDesktopFlowId) {
      void api.codexOauth.cancelDesktopFlow({ flowId: codexOauthDesktopFlowId });
    }
    if (codexOauthDeviceFlow) {
      void api.codexOauth.cancelDeviceFlow({ flowId: codexOauthDeviceFlow.flowId });
    }

    setCodexOauthError(null);
    setCodexOauthDesktopFlowId(null);
    setCodexOauthDeviceFlow(null);
    setCodexOauthAuthorizeUrl(null);

    try {
      setCodexOauthStatus("starting");
      const startResult = await api.codexOauth.startDeviceFlow();

      if (attempt !== codexOauthAttemptRef.current) {
        if (startResult.success) {
          void api.codexOauth.cancelDeviceFlow({ flowId: startResult.data.flowId });
        }
        return;
      }

      if (!startResult.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(startResult.error);
        return;
      }

      setCodexOauthDeviceFlow({
        flowId: startResult.data.flowId,
        userCode: startResult.data.userCode,
        verifyUrl: startResult.data.verifyUrl,
      });
      setCodexOauthStatus("waiting");

      const waitResult = await api.codexOauth.waitForDeviceFlow({
        flowId: startResult.data.flowId,
      });

      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      if (!waitResult.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(waitResult.error);
        return;
      }

      setCodexOauthStatus("idle");
      setCodexOauthDeviceFlow(null);
      setCodexOauthAuthorizeUrl(null);
      await refresh();
    } catch (err) {
      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      setCodexOauthStatus("error");
      setCodexOauthError(getErrorMessage(err));
    }
  };

  const disconnectCodexOauth = async () => {
    const attempt = ++codexOauthAttemptRef.current;

    if (!api) {
      setCodexOauthStatus("error");
      setCodexOauthError("Mux API not connected.");
      return;
    }

    // Best-effort: cancel any in-progress flow.
    if (codexOauthDesktopFlowId) {
      void api.codexOauth.cancelDesktopFlow({ flowId: codexOauthDesktopFlowId });
    }
    if (codexOauthDeviceFlow) {
      void api.codexOauth.cancelDeviceFlow({ flowId: codexOauthDeviceFlow.flowId });
    }

    setCodexOauthError(null);
    setCodexOauthDesktopFlowId(null);
    setCodexOauthDeviceFlow(null);
    setCodexOauthAuthorizeUrl(null);

    try {
      setCodexOauthStatus("starting");
      const result = await api.codexOauth.disconnect();

      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      if (!result.success) {
        setCodexOauthStatus("error");
        setCodexOauthError(result.error);
        return;
      }

      updateOptimistically("openai", { codexOauthSet: false });
      setCodexOauthStatus("idle");
      await refresh();
    } catch (err) {
      if (attempt !== codexOauthAttemptRef.current) {
        return;
      }

      setCodexOauthStatus("error");
      setCodexOauthError(getErrorMessage(err));
    }
  };

  const [muxGatewayLoginStatus, setMuxGatewayLoginStatus] = useState<MuxGatewayLoginStatus>("idle");
  const cancelCodexOauth = () => {
    codexOauthAttemptRef.current++;

    if (api) {
      if (codexOauthDesktopFlowId) {
        void api.codexOauth.cancelDesktopFlow({ flowId: codexOauthDesktopFlowId });
      }
      if (codexOauthDeviceFlow) {
        void api.codexOauth.cancelDeviceFlow({ flowId: codexOauthDeviceFlow.flowId });
      }
    }

    setCodexOauthDesktopFlowId(null);
    setCodexOauthDeviceFlow(null);
    setCodexOauthAuthorizeUrl(null);
    setCodexOauthStatus("idle");
    setCodexOauthError(null);
  };

  const [muxGatewayLoginError, setMuxGatewayLoginError] = useState<string | null>(null);

  const muxGatewayApplyDefaultModelsOnSuccessRef = useRef(false);
  const muxGatewayLoginAttemptRef = useRef(0);
  const [muxGatewayDesktopFlowId, setMuxGatewayDesktopFlowId] = useState<string | null>(null);
  const [muxGatewayServerState, setMuxGatewayServerState] = useState<string | null>(null);

  const [muxGatewayAuthorizeUrl, setMuxGatewayAuthorizeUrl] = useState<string | null>(null);

  const cancelMuxGatewayLogin = () => {
    muxGatewayApplyDefaultModelsOnSuccessRef.current = false;
    muxGatewayLoginAttemptRef.current++;

    if (isDesktop && api && muxGatewayDesktopFlowId) {
      void api.muxGatewayOauth.cancelDesktopFlow({ flowId: muxGatewayDesktopFlowId });
    }

    setMuxGatewayDesktopFlowId(null);
    setMuxGatewayServerState(null);
    setMuxGatewayAuthorizeUrl(null);
    setMuxGatewayLoginStatus("idle");
    setMuxGatewayLoginError(null);
  };

  const clearMuxGatewayCredentials = () => {
    if (!api) {
      return;
    }

    cancelMuxGatewayLogin();
    updateOptimistically("mux-gateway", { couponCodeSet: false });

    void api.providers.setProviderConfig({
      provider: "mux-gateway",
      keyPath: ["couponCode"],
      value: "",
    });
    void api.providers.setProviderConfig({
      provider: "mux-gateway",
      keyPath: ["voucher"],
      value: "",
    });
  };

  const startMuxGatewayLogin = async () => {
    const attempt = ++muxGatewayLoginAttemptRef.current;

    try {
      // Enable default gateway models only for confirmed first-time setup.
      // If config hydration is unknown, prefer preserving current selections.
      let gatewayConfig = config?.["mux-gateway"];
      if (gatewayConfig?.couponCodeSet == null && api) {
        try {
          const latestConfig = await api.providers.getConfig();
          if (attempt !== muxGatewayLoginAttemptRef.current) {
            return;
          }
          gatewayConfig = latestConfig?.["mux-gateway"];
        } catch {
          // If pre-login config fetch fails, avoid defaulting so we don't
          // overwrite an intentional empty model selection.
        }
      }
      muxGatewayApplyDefaultModelsOnSuccessRef.current = gatewayConfig?.couponCodeSet === false;

      setMuxGatewayLoginError(null);
      setMuxGatewayDesktopFlowId(null);
      setMuxGatewayServerState(null);
      setMuxGatewayAuthorizeUrl(null);

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
        setMuxGatewayAuthorizeUrl(authorizeUrl);
        setMuxGatewayLoginStatus("waiting");

        if (attempt !== muxGatewayLoginAttemptRef.current) {
          return;
        }

        const waitResult = await api.muxGatewayOauth.waitForDesktopFlow({ flowId });

        if (attempt !== muxGatewayLoginAttemptRef.current) {
          return;
        }

        if (waitResult.success) {
          if (muxGatewayApplyDefaultModelsOnSuccessRef.current) {
            let latestConfig = config;
            try {
              latestConfig = await api.providers.getConfig();
            } catch {
              // Ignore errors fetching config; fall back to the current snapshot.
            }

            if (attempt !== muxGatewayLoginAttemptRef.current) {
              return;
            }

            const latestGatewayModels = latestConfig?.["mux-gateway"]?.gatewayModels ?? [];
            if (latestGatewayModels.length === 0) {
              gateway.setEnabledModels(getEligibleGatewayModels(latestConfig));
            }
            muxGatewayApplyDefaultModelsOnSuccessRef.current = false;
          }

          setMuxGatewayLoginStatus("success");
          void refreshMuxGatewayAccountStatus();
          return;
        }

        setMuxGatewayAuthorizeUrl(null);
        setMuxGatewayLoginStatus("error");
        setMuxGatewayLoginError(waitResult.error);
        return;
      }

      // Browser/server mode: use unauthenticated bootstrap route.
      setMuxGatewayLoginStatus("starting");

      const startUrl = new URL(`${backendBaseUrl}/auth/mux-gateway/start`);
      const authToken = getServerAuthToken();

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

      const json = (await res.json()) as {
        authorizeUrl?: unknown;
        state?: unknown;
        error?: unknown;
      };

      if (!res.ok) {
        const message = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
        throw new Error(message);
      }

      if (attempt !== muxGatewayLoginAttemptRef.current) {
        return;
      }

      if (typeof json.authorizeUrl !== "string" || typeof json.state !== "string") {
        throw new Error(`Invalid response from ${startUrl.pathname}`);
      }

      setMuxGatewayServerState(json.state);
      setMuxGatewayAuthorizeUrl(json.authorizeUrl);
      setMuxGatewayLoginStatus("waiting");
    } catch (err) {
      if (attempt !== muxGatewayLoginAttemptRef.current) {
        return;
      }

      const message = getErrorMessage(err);
      setMuxGatewayAuthorizeUrl(null);
      setMuxGatewayLoginStatus("error");
      setMuxGatewayLoginError(message);
    }
  };

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
            const latestGatewayModels = latestConfig?.["mux-gateway"]?.gatewayModels ?? [];
            if (latestGatewayModels.length === 0) {
              gateway.setEnabledModels(getEligibleGatewayModels(latestConfig));
            }
          };

          if (api) {
            api.providers
              .getConfig()
              .then(applyLatest)
              .catch(() => applyLatest(config));
          } else {
            applyLatest(config);
          }
        }

        setMuxGatewayAuthorizeUrl(null);
        setMuxGatewayLoginStatus("success");
        void refreshMuxGatewayAccountStatus();
        return;
      }

      const msg = typeof data.error === "string" ? data.error : "Login failed";
      setMuxGatewayAuthorizeUrl(null);
      setMuxGatewayLoginStatus("error");
      setMuxGatewayLoginError(msg);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    isDesktop,
    muxGatewayLoginStatus,
    muxGatewayServerState,
    backendOrigin,
    api,
    config,
    gateway,
    refreshMuxGatewayAccountStatus,
  ]);
  const muxGatewayCouponCodeSet = config?.["mux-gateway"]?.couponCodeSet ?? false;
  const muxGatewayLoginInProgress =
    muxGatewayLoginStatus === "waiting" || muxGatewayLoginStatus === "starting";
  const muxGatewayIsLoggedIn = muxGatewayCouponCodeSet || muxGatewayLoginStatus === "success";

  const muxGatewayAuthStatusText = muxGatewayIsLoggedIn ? "Logged in" : "Not logged in";

  const muxGatewayLoginButtonLabel =
    muxGatewayLoginStatus === "error"
      ? "Try again"
      : muxGatewayLoginInProgress
        ? "Waiting for login..."
        : muxGatewayIsLoggedIn
          ? "Re-login to Mux Gateway"
          : "Login to Mux Gateway";

  // --- GitHub Copilot Device Code Flow ---
  const [copilotLoginStatus, setCopilotLoginStatus] = useState<CopilotLoginStatus>("idle");
  const [copilotLoginError, setCopilotLoginError] = useState<string | null>(null);
  const [copilotFlowId, setCopilotFlowId] = useState<string | null>(null);
  const [copilotUserCode, setCopilotUserCode] = useState<string | null>(null);
  const [copilotVerificationUri, setCopilotVerificationUri] = useState<string | null>(null);
  const copilotLoginAttemptRef = useRef(0);
  const copilotFlowIdRef = useRef<string | null>(null);

  const copilotApiKeySet = config?.["github-copilot"]?.apiKeySet ?? false;
  const copilotLoginInProgress =
    copilotLoginStatus === "waiting" || copilotLoginStatus === "starting";
  const copilotIsLoggedIn = copilotApiKeySet || copilotLoginStatus === "success";

  const cancelCopilotLogin = () => {
    copilotLoginAttemptRef.current++;
    if (api && copilotFlowId) {
      void api.copilotOauth.cancelDeviceFlow({
        flowId: copilotFlowId,
      });
    }
    setCopilotFlowId(null);
    copilotFlowIdRef.current = null;
    setCopilotUserCode(null);
    setCopilotVerificationUri(null);
    setCopilotLoginStatus("idle");
    setCopilotLoginError(null);
  };

  // Cancel any in-flight Copilot login if the component unmounts.
  // Use a ref for api so this only fires on true unmount, not on api identity
  // changes (e.g. reconnection), which would spuriously cancel active flows.
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    return () => {
      if (copilotFlowIdRef.current && apiRef.current) {
        void apiRef.current.copilotOauth.cancelDeviceFlow({ flowId: copilotFlowIdRef.current });
      }
    };
  }, []);

  const clearCopilotCredentials = () => {
    if (!api) return;
    cancelCopilotLogin();
    updateOptimistically("github-copilot", { apiKeySet: false });
    void api.providers.setProviderConfig({
      provider: "github-copilot",
      keyPath: ["apiKey"],
      value: "",
    });
  };

  const startCopilotLogin = async () => {
    const attempt = ++copilotLoginAttemptRef.current;
    try {
      setCopilotLoginError(null);
      setCopilotLoginStatus("starting");

      if (!api) {
        setCopilotLoginStatus("error");
        setCopilotLoginError("API not connected.");
        return;
      }

      // Best-effort: cancel any in-progress flow before starting a new one.
      if (copilotFlowIdRef.current) {
        void api.copilotOauth.cancelDeviceFlow({ flowId: copilotFlowIdRef.current });
        copilotFlowIdRef.current = null;
        setCopilotFlowId(null);
      }

      const startResult = await api.copilotOauth.startDeviceFlow();

      if (attempt !== copilotLoginAttemptRef.current) {
        if (startResult.success) {
          void api.copilotOauth.cancelDeviceFlow({ flowId: startResult.data.flowId });
        }
        return;
      }

      if (!startResult.success) {
        setCopilotLoginStatus("error");
        setCopilotLoginError(startResult.error);
        return;
      }

      const { flowId, verificationUri, userCode } = startResult.data;
      setCopilotFlowId(flowId);
      copilotFlowIdRef.current = flowId;
      setCopilotUserCode(userCode);
      setCopilotVerificationUri(verificationUri);
      setCopilotLoginStatus("waiting");

      // Keep device-code login manual per user request: we only open the
      // verification page from the explicit "Copy & Open" action.

      // Wait for flow to complete (polling happens on backend)
      const waitResult = await api.copilotOauth.waitForDeviceFlow({ flowId });

      if (attempt !== copilotLoginAttemptRef.current) return;

      if (waitResult.success) {
        setCopilotLoginStatus("success");
        return;
      }

      setCopilotLoginStatus("error");
      setCopilotLoginError(waitResult.error);
    } catch (err) {
      if (attempt !== copilotLoginAttemptRef.current) return;
      const message = getErrorMessage(err);
      setCopilotLoginStatus("error");
      setCopilotLoginError(message);
    }
  };

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  useEffect(() => {
    if (!providersExpandedProvider) {
      return;
    }

    setExpandedProvider(providersExpandedProvider);
    setProvidersExpandedProvider(null);
  }, [providersExpandedProvider, setProvidersExpandedProvider]);

  useEffect(() => {
    if (expandedProvider !== "mux-gateway" || !muxGatewayIsLoggedIn) {
      return;
    }

    // Fetch lazily when the user expands the Mux Gateway provider.
    //
    // Important: avoid auto-retrying after a failure. If the request fails,
    // `muxGatewayAccountStatus` remains null and we'd otherwise trigger a refresh
    // on every render while the provider stays expanded.
    if (muxGatewayAccountStatus || muxGatewayAccountLoading || muxGatewayAccountError) {
      return;
    }

    void refreshMuxGatewayAccountStatus();
  }, [
    expandedProvider,
    muxGatewayAccountError,
    muxGatewayAccountLoading,
    muxGatewayAccountStatus,
    muxGatewayIsLoggedIn,
    refreshMuxGatewayAccountStatus,
  ]);
  const [editingField, setEditingField] = useState<{
    provider: string;
    field: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleToggleProvider = (provider: string) => {
    setExpandedProvider((prev) => {
      const next = prev === provider ? null : provider;
      if (prev === "mux-gateway" && next !== "mux-gateway") {
        cancelMuxGatewayLogin();
      }
      if (prev === "github-copilot" && next !== "github-copilot") {
        cancelCopilotLogin();
      }
      return next;
    });
    setEditingField(null);
  };

  const handleStartEdit = (provider: string, field: string, fieldConfig: FieldConfig) => {
    setEditingField({ provider, field });
    // For secrets, start empty since we only show masked value
    // For text fields, show current value
    const currentValue = getFieldValue(provider, field);
    setEditValue(fieldConfig.type === "text" && currentValue ? currentValue : "");
  };

  const handleCancelEdit = () => {
    setEditingField(null);
    setEditValue("");
    setShowPassword(false);
  };

  const handleSaveEdit = useCallback(() => {
    if (!editingField || !api) return;

    const { provider, field } = editingField;

    // Optimistic update for instant feedback
    if (field === "apiKey") {
      updateOptimistically(provider, { apiKeySet: editValue !== "" });
    } else if (field === "baseUrl") {
      updateOptimistically(provider, { baseUrl: editValue || undefined });
    }

    setEditingField(null);
    setEditValue("");
    setShowPassword(false);

    // Save in background
    void api.providers.setProviderConfig({ provider, keyPath: [field], value: editValue });
  }, [api, editingField, editValue, updateOptimistically]);

  const handleClearField = useCallback(
    (provider: string, field: string) => {
      if (!api) return;

      // Optimistic update for instant feedback
      if (field === "apiKey") {
        updateOptimistically(provider, { apiKeySet: false });
      } else if (field === "baseUrl") {
        updateOptimistically(provider, { baseUrl: undefined });
      }

      // Save in background
      void api.providers.setProviderConfig({ provider, keyPath: [field], value: "" });
    },
    [api, updateOptimistically]
  );

  const isEnabled = (provider: string): boolean => {
    return config?.[provider]?.isEnabled ?? true;
  };

  /** Check if provider is configured (uses backend-computed isConfigured) */
  const isConfigured = (provider: string): boolean => {
    return config?.[provider]?.isConfigured ?? false;
  };

  const hasAnyConfiguredProvider = useMemo(
    () => Object.values(config ?? {}).some((providerConfig) => providerConfig.isConfigured),
    [config]
  );

  const handleProviderEnabledChange = useCallback(
    (provider: string, nextEnabled: boolean) => {
      if (!api || provider === "mux-gateway") {
        return;
      }

      updateOptimistically(provider, {
        isEnabled: nextEnabled,
        ...(nextEnabled ? {} : { isConfigured: false }),
      });

      // Persist only `enabled: false` for disabled providers. Re-enabling removes the key.
      void api.providers.setProviderConfig({
        provider,
        keyPath: ["enabled"],
        value: nextEnabled ? "" : "false",
      });
    },
    [api, updateOptimistically]
  );

  const getFieldValue = (provider: string, field: string): string | undefined => {
    const providerConfig = config?.[provider];
    if (!providerConfig) return undefined;

    // For bedrock, check aws nested object for region/profile
    if (provider === "bedrock" && (field === "region" || field === "profile")) {
      return field === "region" ? providerConfig.aws?.region : providerConfig.aws?.profile;
    }

    // For standard fields like baseUrl
    const value = providerConfig[field as keyof typeof providerConfig];
    return typeof value === "string" ? value : undefined;
  };

  const isFieldSet = (provider: string, field: string, fieldConfig: FieldConfig): boolean => {
    const providerConfig = config?.[provider];
    if (!providerConfig) return false;

    if (fieldConfig.type === "secret") {
      // For apiKey, we have apiKeySet from the sanitized config
      if (field === "apiKey") return providerConfig.apiKeySet ?? false;

      // For AWS secrets, check the aws nested object
      if (provider === "bedrock" && providerConfig.aws) {
        const { aws } = providerConfig;
        switch (field) {
          case "bearerToken":
            return aws.bearerTokenSet ?? false;
          case "accessKeyId":
            return aws.accessKeyIdSet ?? false;
          case "secretAccessKey":
            return aws.secretAccessKeySet ?? false;
        }
      }
      return false;
    }
    return !!getFieldValue(provider, field);
  };

  return (
    <div className="space-y-2">
      <p className="text-muted mb-4 text-xs">
        Configure API keys and endpoints for AI providers. Keys are stored in{" "}
        <code className="text-accent">~/.mux/providers.jsonc</code>
      </p>

      {policyState.status.state === "enforced" && (
        <div className="border-border-medium bg-background-secondary/50 text-muted flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <span>Your settings are controlled by a policy.</span>
        </div>
      )}

      {visibleProviders.map((provider) => {
        const isExpanded = expandedProvider === provider;
        // mux-gateway enabled/models are sourced from backend config.json via
        // useGateway/useProvidersConfig, so read the gateway hook's state directly.
        const enabled = provider === "mux-gateway" ? gateway.isEnabled : isEnabled(provider);
        const configured = isConfigured(provider);
        const fields = getProviderFields(provider);
        const statusDotColor = !enabled
          ? "bg-warning"
          : configured
            ? "bg-success"
            : "bg-border-medium";
        const statusDotTitle = !enabled ? "Disabled" : configured ? "Configured" : "Not configured";

        return (
          <div
            key={provider}
            className="border-border-medium bg-background-secondary overflow-hidden rounded-md border"
          >
            {/* Provider header */}
            <Button
              variant="ghost"
              onClick={() => handleToggleProvider(provider)}
              className="flex h-auto w-full items-center justify-between rounded-none px-4 py-3 text-left"
            >
              <div className="flex items-center gap-3">
                {isExpanded ? (
                  <ChevronDown className="text-muted h-4 w-4" />
                ) : (
                  <ChevronRight className="text-muted h-4 w-4" />
                )}
                <ProviderWithIcon
                  provider={provider}
                  displayName
                  className="text-foreground text-sm font-medium"
                />
              </div>
              <div className={`h-2 w-2 rounded-full ${statusDotColor}`} title={statusDotTitle} />
            </Button>

            {/* Provider settings */}
            {isExpanded && (
              <div className="border-border-medium space-y-3 border-t px-4 py-3">
                {provider !== "mux-gateway" && (
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <label className="text-foreground block text-xs font-medium">Enabled</label>
                      <span className="text-muted text-xs">
                        Disable this provider without deleting saved credentials.
                      </span>
                    </div>
                    <Switch
                      checked={enabled}
                      onCheckedChange={(nextChecked) =>
                        handleProviderEnabledChange(provider, nextChecked)
                      }
                      aria-label={`Toggle ${provider} provider`}
                      disabled={!api}
                    />
                  </div>
                )}

                {/* Quick link to get API key */}
                {PROVIDER_KEY_URLS[provider] && (
                  <div className="space-y-1">
                    <a
                      href={PROVIDER_KEY_URLS[provider]}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted hover:text-accent inline-flex items-center gap-1 text-xs transition-colors"
                    >
                      Get API Key
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                    {provider === "anthropic" &&
                      configured &&
                      config?.[provider]?.apiKeySet === false && (
                        <div className="text-muted text-xs">
                          Configured via environment variables.
                        </div>
                      )}
                  </div>
                )}

                {provider === "mux-gateway" && (
                  <div className="space-y-2">
                    <div>
                      <label className="text-foreground block text-xs font-medium">
                        Authentication
                      </label>
                      <span className="text-muted text-xs">{muxGatewayAuthStatusText}</span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            void startMuxGatewayLogin();
                          }}
                          disabled={muxGatewayLoginInProgress}
                        >
                          {muxGatewayLoginButtonLabel}
                        </Button>

                        {muxGatewayLoginStatus === "waiting" && muxGatewayAuthorizeUrl && (
                          <Button
                            size="sm"
                            aria-label="Copy and open Mux Gateway authorization page"
                            onClick={() => {
                              void navigator.clipboard.writeText(muxGatewayAuthorizeUrl);
                              window.open(muxGatewayAuthorizeUrl, "_blank", "noopener");
                            }}
                            className="h-8 px-3 text-xs"
                          >
                            Copy & Open Mux Gateway
                          </Button>
                        )}

                        {muxGatewayLoginInProgress && (
                          <Button variant="secondary" size="sm" onClick={cancelMuxGatewayLogin}>
                            Cancel
                          </Button>
                        )}

                        {muxGatewayIsLoggedIn && (
                          <Button variant="ghost" size="sm" onClick={clearMuxGatewayCredentials}>
                            Log out
                          </Button>
                        )}
                      </div>

                      {muxGatewayLoginStatus === "waiting" && (
                        <p className="text-muted inline-flex items-center gap-2 text-xs">
                          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                          Waiting for authorization...
                        </p>
                      )}

                      {muxGatewayLoginStatus === "error" && muxGatewayLoginError && (
                        <p className="text-destructive text-xs">
                          Login failed: {muxGatewayLoginError}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {provider === "mux-gateway" && muxGatewayIsLoggedIn && (
                  <div className="border-border-light space-y-2 border-t pt-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <label className="text-foreground block text-xs font-medium">Account</label>
                        <span className="text-muted text-xs">
                          Balance and limits from Mux Gateway
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void refreshMuxGatewayAccountStatus();
                        }}
                        disabled={muxGatewayAccountLoading}
                      >
                        {muxGatewayAccountLoading ? "Refreshing..." : "Refresh"}
                      </Button>
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <span className="text-muted text-xs">Balance</span>
                      <span className="text-foreground font-mono text-xs">
                        {formatMuxGatewayBalance(muxGatewayAccountStatus?.remaining_microdollars)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <span className="text-muted text-xs">Concurrent requests per user</span>
                      <span className="text-foreground font-mono text-xs">
                        {muxGatewayAccountStatus?.ai_gateway_concurrent_requests_per_user ?? "—"}
                      </span>
                    </div>

                    {muxGatewayAccountError && (
                      <p className="text-destructive text-xs">{muxGatewayAccountError}</p>
                    )}
                  </div>
                )}

                {provider === "github-copilot" && (
                  <div className="space-y-2">
                    <div>
                      <label className="text-foreground block text-xs font-medium">
                        Authentication
                      </label>
                      <span className="text-muted text-xs">
                        {copilotIsLoggedIn ? "Logged in" : "Not logged in"}
                      </span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            void startCopilotLogin();
                          }}
                          disabled={copilotLoginInProgress}
                        >
                          {copilotLoginStatus === "error"
                            ? "Try again"
                            : copilotLoginInProgress
                              ? "Waiting for authorization..."
                              : copilotIsLoggedIn
                                ? "Re-login with GitHub"
                                : "Login with GitHub"}
                        </Button>

                        {copilotLoginInProgress && (
                          <Button variant="secondary" size="sm" onClick={cancelCopilotLogin}>
                            Cancel
                          </Button>
                        )}

                        {copilotIsLoggedIn && (
                          <Button variant="ghost" size="sm" onClick={clearCopilotCredentials}>
                            Log out
                          </Button>
                        )}
                      </div>

                      {copilotLoginStatus === "waiting" && copilotUserCode && (
                        <div className="bg-background-tertiary space-y-2 rounded-md p-3">
                          <p className="text-muted text-xs">Enter this code on GitHub:</p>
                          <div className="flex items-center gap-2">
                            <code className="text-foreground text-lg font-bold tracking-widest">
                              {copilotUserCode}
                            </code>
                            <Button
                              size="sm"
                              aria-label="Copy and open GitHub verification page"
                              onClick={() => {
                                void navigator.clipboard.writeText(copilotUserCode);
                                if (copilotVerificationUri) {
                                  window.open(copilotVerificationUri, "_blank", "noopener");
                                }
                              }}
                              className="h-8 px-3 text-xs"
                              disabled={!copilotVerificationUri}
                            >
                              Copy & Open GitHub
                            </Button>
                          </div>
                          <p className="text-muted inline-flex items-center gap-2 text-xs">
                            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                            Waiting for authorization...
                          </p>
                        </div>
                      )}

                      {copilotLoginStatus === "error" && copilotLoginError && (
                        <p className="text-destructive text-xs">
                          Login failed: {copilotLoginError}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {fields.map((fieldConfig) => {
                  const isEditing =
                    editingField?.provider === provider && editingField?.field === fieldConfig.key;
                  const fieldValue = getFieldValue(provider, fieldConfig.key);
                  const fieldIsSet = isFieldSet(provider, fieldConfig.key, fieldConfig);

                  return (
                    <div key={fieldConfig.key}>
                      <label className="text-muted mb-1 block text-xs">
                        {fieldConfig.label}
                        {fieldConfig.optional && <span className="text-dim"> (optional)</span>}
                      </label>
                      {isEditing ? (
                        <div className="flex gap-2">
                          <input
                            type={
                              fieldConfig.type === "secret" && !showPassword ? "password" : "text"
                            }
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            placeholder={fieldConfig.placeholder}
                            className="bg-modal-bg border-border-medium focus:border-accent flex-1 rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                            autoFocus
                            onKeyDown={createEditKeyHandler({
                              onSave: handleSaveEdit,
                              onCancel: handleCancelEdit,
                            })}
                          />
                          {fieldConfig.type === "secret" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setShowPassword(!showPassword)}
                              className="text-muted hover:text-foreground h-6 w-6"
                              title={showPassword ? "Hide password" : "Show password"}
                            >
                              {showPassword ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleSaveEdit}
                            className="h-6 w-6 text-green-500 hover:text-green-400"
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleCancelEdit}
                            className="text-muted hover:text-foreground h-6 w-6"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <span className="text-foreground font-mono text-xs">
                            {fieldConfig.type === "secret"
                              ? fieldIsSet
                                ? "••••••••"
                                : "Not set"
                              : (fieldValue ?? "Default")}
                          </span>
                          <div className="flex gap-2">
                            {(fieldConfig.type === "text"
                              ? !!fieldValue
                              : fieldConfig.type === "secret" && fieldIsSet) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleClearField(provider, fieldConfig.key)}
                                className="text-muted hover:text-error h-auto px-1 py-0 text-xs"
                              >
                                Clear
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                handleStartEdit(provider, fieldConfig.key, fieldConfig)
                              }
                              className="text-accent hover:text-accent-light h-auto px-1 py-0 text-xs"
                            >
                              {fieldIsSet || fieldValue ? "Change" : "Set"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Anthropic: prompt cache TTL */}
                {provider === "anthropic" && (
                  <>
                    <div className="border-border-light border-t pt-3">
                      <div className="mb-1 flex items-center gap-1">
                        <label className="text-muted block text-xs">Prompt cache TTL</label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpIndicator aria-label="Anthropic prompt cache TTL help">
                                ?
                              </HelpIndicator>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="max-w-[280px]">
                                <div className="font-semibold">Prompt cache TTL</div>
                                <div className="mt-1">
                                  Default is <span className="font-semibold">5m</span>. Use{" "}
                                  <span className="font-semibold">1h</span> for longer workflows at
                                  a higher cache-write cost.
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>

                      <Select
                        value={config?.anthropic?.cacheTtl === "1h" ? "1h" : "default"}
                        onValueChange={(next) => {
                          if (!api) {
                            return;
                          }
                          if (next !== "default" && next !== "1h") {
                            return;
                          }

                          const cacheTtl = next === "1h" ? "1h" : undefined;
                          updateOptimistically("anthropic", { cacheTtl });
                          void api.providers.setProviderConfig({
                            provider: "anthropic",
                            keyPath: ["cacheTtl"],
                            // Empty string clears providers.jsonc key; backend defaults to 5m when unset.
                            value: next === "1h" ? "1h" : "",
                          });
                        }}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default (5m)</SelectItem>
                          <SelectItem value="1h">1 hour</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="border-border-light border-t pt-3">
                      <div className="mb-1 flex items-center gap-1">
                        <label className="text-muted block text-xs">Beta features</label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpIndicator aria-label="Anthropic beta features help">
                                ?
                              </HelpIndicator>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="max-w-[260px]">
                                <div className="font-semibold">Anthropic beta features</div>
                                <div className="mt-1">
                                  Controls 1M context window and prompt caching. Disable for zero
                                  data retention (ZDR) environments where beta features are not
                                  eligible.
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Select
                        value={config?.anthropic?.disableBetaFeatures ? "disabled" : "enabled"}
                        onValueChange={(next) => {
                          if (!api) return;
                          if (next !== "enabled" && next !== "disabled") return;

                          const disableBetaFeatures = next === "disabled" ? true : undefined;
                          updateOptimistically("anthropic", { disableBetaFeatures });
                          void api.providers.setProviderConfig({
                            provider: "anthropic",
                            keyPath: ["disableBetaFeatures"],
                            value: next === "disabled" ? true : "",
                          });
                        }}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="enabled">enabled</SelectItem>
                          <SelectItem value="disabled">disabled</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                {/* OpenAI: ChatGPT OAuth + service tier */}
                {provider === "openai" && (
                  <div className="border-border-light space-y-3 border-t pt-3">
                    <div>
                      <label className="text-foreground block text-xs font-medium">
                        ChatGPT (Codex) OAuth
                      </label>
                      <span className="text-muted text-xs">
                        {codexOauthStatus === "starting"
                          ? "Starting..."
                          : codexOauthStatus === "waiting"
                            ? "Waiting for login..."
                            : codexOauthIsConnected
                              ? "Connected"
                              : "Not connected"}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {!isRemoteServer && (
                        <Button
                          size="sm"
                          onClick={() => {
                            void startCodexOauthBrowserConnect();
                          }}
                          disabled={!api || codexOauthLoginInProgress}
                        >
                          Connect (Browser)
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void startCodexOauthDeviceConnect();
                        }}
                        disabled={!api || codexOauthLoginInProgress}
                      >
                        Connect (Device)
                      </Button>

                      {codexOauthStatus === "waiting" &&
                        !codexOauthDeviceFlow &&
                        codexOauthAuthorizeUrl && (
                          <Button
                            size="sm"
                            aria-label="Copy and open OpenAI authorization page"
                            onClick={() => {
                              void navigator.clipboard.writeText(codexOauthAuthorizeUrl);
                              window.open(codexOauthAuthorizeUrl, "_blank", "noopener");
                            }}
                            className="h-8 px-3 text-xs"
                          >
                            Copy & Open OpenAI
                          </Button>
                        )}

                      {codexOauthLoginInProgress && (
                        <Button variant="secondary" size="sm" onClick={cancelCodexOauth}>
                          Cancel
                        </Button>
                      )}

                      {codexOauthIsConnected && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void disconnectCodexOauth();
                          }}
                          disabled={!api || codexOauthLoginInProgress}
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>

                    {codexOauthDeviceFlow && (
                      <div className="bg-background-tertiary space-y-2 rounded-md p-3">
                        <p className="text-muted text-xs">
                          Enter this code on the OpenAI verification page:
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="text-foreground text-lg font-bold tracking-widest">
                            {codexOauthDeviceFlow.userCode}
                          </code>
                          <Button
                            size="sm"
                            aria-label="Copy and open OpenAI verification page"
                            onClick={() => {
                              void navigator.clipboard.writeText(codexOauthDeviceFlow.userCode);
                              window.open(codexOauthDeviceFlow.verifyUrl, "_blank", "noopener");
                            }}
                            className="h-8 px-3 text-xs"
                          >
                            Copy & Open OpenAI
                          </Button>
                        </div>
                        <p className="text-muted inline-flex items-center gap-2 text-xs">
                          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                          Waiting for authorization...
                        </p>
                      </div>
                    )}

                    {codexOauthStatus === "waiting" && !codexOauthDeviceFlow && (
                      <p className="text-muted inline-flex items-center gap-2 text-xs">
                        <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                        Waiting for authorization...
                      </p>
                    )}

                    {codexOauthStatus === "error" && codexOauthError && (
                      <p className="text-destructive text-xs">{codexOauthError}</p>
                    )}

                    <div className="border-border-light space-y-2 border-t pt-3">
                      <div>
                        <label className="text-muted block text-xs">
                          Default auth (when both are set)
                        </label>
                        <p className="text-muted text-xs">
                          Applies to models that support both ChatGPT OAuth and API keys (e.g.{" "}
                          <code className="text-accent">gpt-5.2</code>).
                        </p>
                      </div>

                      <ToggleGroup
                        type="single"
                        value={codexOauthDefaultAuth}
                        onValueChange={(next) => {
                          if (!api) return;
                          if (next !== "oauth" && next !== "apiKey") {
                            return;
                          }

                          updateOptimistically("openai", { codexOauthDefaultAuth: next });
                          void api.providers.setProviderConfig({
                            provider: "openai",
                            keyPath: ["codexOauthDefaultAuth"],
                            value: next,
                          });
                        }}
                        size="sm"
                        className="h-9"
                        disabled={!api || !codexOauthDefaultAuthIsEditable}
                      >
                        <ToggleGroupItem value="oauth" size="sm" className="h-7 px-3 text-[13px]">
                          Use ChatGPT OAuth by default
                        </ToggleGroupItem>
                        <ToggleGroupItem value="apiKey" size="sm" className="h-7 px-3 text-[13px]">
                          Use OpenAI API key by default
                        </ToggleGroupItem>
                      </ToggleGroup>

                      <p className="text-muted text-xs">
                        ChatGPT OAuth uses subscription billing (costs included). API key uses
                        OpenAI platform billing.
                      </p>

                      {!codexOauthDefaultAuthIsEditable && (
                        <p className="text-muted text-xs">
                          Connect ChatGPT OAuth and set an OpenAI API key to change this setting.
                        </p>
                      )}
                    </div>

                    <div className="border-border-light border-t pt-3">
                      <div className="mb-1 flex items-center gap-1">
                        <label className="text-muted block text-xs">Service tier</label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpIndicator aria-label="OpenAI service tier help">?</HelpIndicator>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="max-w-[260px]">
                                <div className="font-semibold">OpenAI service tier</div>
                                <div className="mt-1">
                                  <span className="font-semibold">auto</span>: standard behavior.
                                </div>
                                <div>
                                  <span className="font-semibold">priority</span>: lower latency,
                                  higher cost.
                                </div>
                                <div>
                                  <span className="font-semibold">flex</span>: lower cost, higher
                                  latency.
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Select
                        value={config?.openai?.serviceTier ?? "auto"}
                        onValueChange={(next) => {
                          if (!api) return;
                          if (
                            next !== "auto" &&
                            next !== "default" &&
                            next !== "flex" &&
                            next !== "priority"
                          ) {
                            return;
                          }

                          updateOptimistically("openai", { serviceTier: next });
                          void api.providers.setProviderConfig({
                            provider: "openai",
                            keyPath: ["serviceTier"],
                            value: next,
                          });
                        }}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">auto</SelectItem>
                          <SelectItem value="default">default</SelectItem>
                          <SelectItem value="flex">flex</SelectItem>
                          <SelectItem value="priority">priority</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="border-border-light border-t pt-3">
                      <div className="mb-1 flex items-center gap-1">
                        <label className="text-muted block text-xs">Wire format</label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpIndicator aria-label="OpenAI wire format help">?</HelpIndicator>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="max-w-[260px]">
                                <div className="font-semibold">OpenAI wire format</div>
                                <div className="mt-1">
                                  <span className="font-semibold">responses</span>: modern API with
                                  persistence and built-in tools (default).
                                </div>
                                <div>
                                  <span className="font-semibold">chat completions</span>: legacy
                                  /chat/completions endpoint. Use if your provider doesn&apos;t
                                  support the Responses API (e.g. Azure Gov).
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Select
                        value={config?.openai?.wireFormat ?? "responses"}
                        onValueChange={(next) => {
                          if (!api) return;
                          if (next !== "responses" && next !== "chatCompletions") return;

                          updateOptimistically("openai", { wireFormat: next });
                          void api.providers.setProviderConfig({
                            provider: "openai",
                            keyPath: ["wireFormat"],
                            value: next,
                          });
                        }}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="responses">responses</SelectItem>
                          <SelectItem value="chatCompletions">chat completions</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="border-border-light border-t pt-3">
                      <div className="mb-1 flex items-center gap-1">
                        <label className="text-muted block text-xs">Response storage</label>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <HelpIndicator aria-label="OpenAI response storage help">
                                ?
                              </HelpIndicator>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="max-w-[260px]">
                                <div className="font-semibold">OpenAI response storage</div>
                                <div className="mt-1">
                                  <span className="font-semibold">enabled</span>: OpenAI stores
                                  responses for retrieval and context (default).
                                </div>
                                <div>
                                  <span className="font-semibold">disabled</span>: responses are not
                                  stored. Required for zero data retention (ZDR) endpoints.
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <Select
                        value={config?.openai?.store === false ? "disabled" : "enabled"}
                        onValueChange={(next) => {
                          if (!api) return;
                          if (next !== "enabled" && next !== "disabled") return;

                          const store = next === "disabled" ? false : undefined;
                          updateOptimistically("openai", { store });
                          void api.providers.setProviderConfig({
                            provider: "openai",
                            keyPath: ["store"],
                            value: next === "disabled" ? false : "",
                          });
                        }}
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="enabled">enabled</SelectItem>
                          <SelectItem value="disabled">disabled</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                {/* Gateway toggles - only for mux-gateway when configured */}
                {provider === "mux-gateway" && gateway.isConfigured && (
                  <div className="border-border-light space-y-3 border-t pt-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-foreground block text-xs font-medium">Enabled</label>
                        <span className="text-muted text-xs">
                          Route requests through Mux Gateway
                        </span>
                      </div>
                      <Switch
                        checked={gateway.isEnabled}
                        onCheckedChange={() => gateway.toggleEnabled()}
                        aria-label="Toggle Mux Gateway"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <label className="text-foreground block text-xs font-medium">
                          Enable for all models
                        </label>
                        <span className="text-muted text-xs">
                          Turn on Mux Gateway for every eligible model.
                        </span>
                      </div>
                      {canEnableGatewayForAllModels ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={enableGatewayForAllModels}
                          aria-label="Enable Mux Gateway for all models"
                        >
                          Enable all
                        </Button>
                      ) : (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={enableGatewayForAllModels}
                                  disabled
                                  aria-label="Enable Mux Gateway for all models"
                                >
                                  Enable all
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              All eligible models are already enabled.
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {config && !hasAnyConfiguredProvider && (
        <div className="border-warning/40 bg-warning/10 text-warning rounded-md border px-3 py-2 text-xs">
          No providers are currently enabled. You won&apos;t be able to send messages until you
          enable a provider.
        </div>
      )}
    </div>
  );
}
