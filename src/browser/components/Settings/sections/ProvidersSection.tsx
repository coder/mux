import React, { useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Check, X, Eye, EyeOff } from "lucide-react";
import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import type { ProviderName } from "@/common/constants/providers";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon";
import { useAPI } from "@/browser/contexts/API";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useGateway } from "@/browser/hooks/useGatewayModels";
import { Button } from "@/browser/components/ui/button";
import { Switch } from "@/browser/components/ui/switch";

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

  // Mux Gateway only needs couponCode
  if (provider === "mux-gateway") {
    return [
      { key: "couponCode", label: "Coupon Code", placeholder: "Enter coupon code", type: "secret" },
    ];
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

export function ProvidersSection() {
  const { api } = useAPI();
  const { config, updateOptimistically } = useProvidersConfig();
  const gateway = useGateway();
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<{
    provider: string;
    field: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleToggleProvider = (provider: string) => {
    setExpandedProvider((prev) => (prev === provider ? null : provider));
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
    } else if (field === "couponCode") {
      updateOptimistically(provider, { couponCodeSet: editValue !== "" });
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
      } else if (field === "couponCode") {
        updateOptimistically(provider, { couponCodeSet: false });
      }

      // Save in background
      void api.providers.setProviderConfig({ provider, keyPath: [field], value: "" });
    },
    [api, updateOptimistically]
  );

  const isConfigured = (provider: string): boolean => {
    const providerConfig = config?.[provider];
    if (!providerConfig) return false;

    // For Bedrock, check if any AWS credential field is set
    if (provider === "bedrock" && providerConfig.aws) {
      const { aws } = providerConfig;
      return !!(aws.region ?? aws.bearerTokenSet ?? aws.accessKeyIdSet ?? aws.secretAccessKeySet);
    }

    // For Mux Gateway, check couponCodeSet
    if (provider === "mux-gateway") {
      return providerConfig.couponCodeSet ?? false;
    }

    // For other providers, check apiKeySet
    return providerConfig.apiKeySet ?? false;
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
      // For couponCode (mux-gateway), check couponCodeSet
      if (field === "couponCode") return providerConfig.couponCodeSet ?? false;

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

                {/* Gateway enabled toggle - only for mux-gateway when configured */}
                {provider === "mux-gateway" && gateway.isConfigured && (
                  <div className="border-border-light flex items-center justify-between border-t pt-3">
                    <div>
                      <label className="text-foreground block text-xs font-medium">Enabled</label>
                      <span className="text-muted text-xs">Route requests through Mux Gateway</span>
                    </div>
                    <Switch
                      checked={gateway.isEnabled}
                      onCheckedChange={() => gateway.toggleEnabled()}
                      aria-label="Toggle Mux Gateway"
                    />
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
