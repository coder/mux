import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Check, X, Eye, EyeOff, ExternalLink } from "lucide-react";

import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { ProviderName } from "@/common/constants/providers";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon";
import { getStoredAuthToken } from "@/browser/components/AuthTokenModal";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useGateway } from "@/browser/hooks/useGatewayModels";
import { getEligibleGatewayModels } from "@/browser/utils/gatewayModels";
import { Button } from "@/browser/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { Switch } from "@/browser/components/ui/switch";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/browser/components/ui/tooltip";

type MuxGatewayLoginStatus = "idle" | "starting" | "waiting" | "success" | "error";

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
function getBackendBaseUrl(): string {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
  // @ts-ignore - import.meta is available in Vite
  return import.meta.env.VITE_BACKEND_URL ?? window.location.origin;
}
const GATEWAY_MODELS_KEY = "gateway-models";

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
  const { providersExpandedProvider, setProvidersExpandedProvider } = useSettings();

  const { api } = useAPI();
  const { config, updateOptimistically } = useProvidersConfig();

  const [gatewayModels, setGatewayModels] = usePersistedState<string[]>(GATEWAY_MODELS_KEY, [], {
    listener: true,
  });

  const eligibleGatewayModels = useMemo(() => getEligibleGatewayModels(config), [config]);

  const isGatewayDefaultEnabled = useMemo(
    () =>
      eligibleGatewayModels.length > 0 &&
      eligibleGatewayModels.every((modelId) => gatewayModels.includes(modelId)),
    [eligibleGatewayModels, gatewayModels]
  );

  const setGatewayDefaultEnabled = useCallback(
    (next: boolean) => {
      setGatewayModels(next ? eligibleGatewayModels : []);
    },
    [eligibleGatewayModels, setGatewayModels]
  );

  const gateway = useGateway();

  const backendBaseUrl = getBackendBaseUrl();
  const backendOrigin = (() => {
    try {
      return new URL(backendBaseUrl).origin;
    } catch {
      return window.location.origin;
    }
  })();

  const isDesktop = !!window.api;

  const [muxGatewayLoginStatus, setMuxGatewayLoginStatus] = useState<MuxGatewayLoginStatus>("idle");
  const [muxGatewayLoginError, setMuxGatewayLoginError] = useState<string | null>(null);

  const muxGatewayApplyDefaultModelsOnSuccessRef = useRef(false);
  const muxGatewayLoginAttemptRef = useRef(0);
  const [muxGatewayDesktopFlowId, setMuxGatewayDesktopFlowId] = useState<string | null>(null);
  const [muxGatewayServerState, setMuxGatewayServerState] = useState<string | null>(null);

  const cancelMuxGatewayLogin = () => {
    muxGatewayApplyDefaultModelsOnSuccessRef.current = false;
    muxGatewayLoginAttemptRef.current++;

    if (isDesktop && api && muxGatewayDesktopFlowId) {
      void api.muxGatewayOauth.cancelDesktopFlow({ flowId: muxGatewayDesktopFlowId });
    }

    setMuxGatewayDesktopFlowId(null);
    setMuxGatewayServerState(null);
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

    // Enable Mux Gateway for all eligible models after the *first* successful login.
    // (If config isn't loaded yet, fall back to the persisted gateway-available state.)
    const isLoggedIn = config?.["mux-gateway"]?.couponCodeSet ?? gateway.isConfigured;
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
            let latestConfig = config;
            try {
              latestConfig = await api.providers.getConfig();
            } catch {
              // Ignore errors fetching config; fall back to the current snapshot.
            }

            if (attempt !== muxGatewayLoginAttemptRef.current) {
              return;
            }

            setGatewayModels(getEligibleGatewayModels(latestConfig));
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
            setGatewayModels(getEligibleGatewayModels(latestConfig));
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
    isDesktop,
    muxGatewayLoginStatus,
    muxGatewayServerState,
    backendOrigin,
    api,
    config,
    setGatewayModels,
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

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  useEffect(() => {
    if (!providersExpandedProvider) {
      return;
    }

    setExpandedProvider(providersExpandedProvider);
    setProvidersExpandedProvider(null);
  }, [providersExpandedProvider, setProvidersExpandedProvider]);
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

  /** Check if provider is configured (uses backend-computed isConfigured) */
  const isConfigured = (provider: string): boolean => {
    return config?.[provider]?.isConfigured ?? false;
  };

  const getFieldValue = (provider: string, field: string): string | undefined => {
    const providerConfig = config?.[provider];
    if (!providerConfig) return undefined;

    // For bedrock, check aws nested object for region
    if (provider === "bedrock" && field === "region") {
      return providerConfig.aws?.region;
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

      {SUPPORTED_PROVIDERS.map((provider) => {
        const isExpanded = expandedProvider === provider;
        const configured = isConfigured(provider);
        const fields = getProviderFields(provider);

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
              <div
                className={`h-2 w-2 rounded-full ${configured ? "bg-green-500" : "bg-border-medium"}`}
                title={configured ? "Configured" : "Not configured"}
              />
            </Button>

            {/* Provider settings */}
            {isExpanded && (
              <div className="border-border-medium space-y-3 border-t px-4 py-3">
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
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            void startMuxGatewayLogin();
                          }}
                          disabled={muxGatewayLoginInProgress}
                        >
                          {muxGatewayLoginButtonLabel}
                        </Button>

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
                        <p className="text-muted text-xs">
                          Finish the login flow in your browser, then return here.
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

                {/* OpenAI service tier dropdown */}
                {provider === "openai" && (
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

                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-foreground block text-xs font-medium">Default</label>
                        <span className="text-muted text-xs">
                          Enabling Mux Gateway as default will set all models to be used through Mux
                          Gateway.
                        </span>
                      </div>
                      <Switch
                        checked={isGatewayDefaultEnabled}
                        onCheckedChange={setGatewayDefaultEnabled}
                        aria-label="Toggle Mux Gateway Default"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
