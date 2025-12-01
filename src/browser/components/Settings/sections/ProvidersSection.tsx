import React, { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, Check, X } from "lucide-react";
import type { ProvidersConfigMap } from "../types";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import type { ProviderName } from "@/common/constants/providers";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon";

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
  const [config, setConfig] = useState<ProvidersConfigMap>({});
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<{
    provider: string;
    field: string;
  } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  // Load config on mount
  useEffect(() => {
    void (async () => {
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);
    })();
  }, []);

  const handleToggleProvider = (provider: string) => {
    setExpandedProvider((prev) => (prev === provider ? null : provider));
    setEditingField(null);
  };

  const handleStartEdit = (provider: string, field: string, fieldConfig: FieldConfig) => {
    setEditingField({ provider, field });
    // For secrets, start empty since we only show masked value
    // For text fields, show current value
    const currentValue = (config[provider] as Record<string, unknown> | undefined)?.[field];
    setEditValue(
      fieldConfig.type === "text" && typeof currentValue === "string" ? currentValue : ""
    );
  };

  const handleCancelEdit = () => {
    setEditingField(null);
    setEditValue("");
  };

  const handleSaveEdit = useCallback(async () => {
    if (!editingField) return;

    setSaving(true);
    try {
      const { provider, field } = editingField;
      await window.api.providers.setProviderConfig(provider, [field], editValue);

      // Refresh config
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);
      setEditingField(null);
      setEditValue("");

      // Notify other components about the change
      window.dispatchEvent(new Event("providers-config-changed"));
    } finally {
      setSaving(false);
    }
  }, [editingField, editValue]);

  const handleClearField = useCallback(async (provider: string, field: string) => {
    setSaving(true);
    try {
      await window.api.providers.setProviderConfig(provider, [field], "");
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);

      // Notify other components about the change
      window.dispatchEvent(new Event("providers-config-changed"));
    } finally {
      setSaving(false);
    }
  }, []);

  const isConfigured = (provider: string): boolean => {
    const providerConfig = config[provider];
    if (!providerConfig) return false;

    // For Bedrock, check if any credential field is set
    if (provider === "bedrock") {
      return !!(
        providerConfig.region ??
        providerConfig.bearerTokenSet ??
        providerConfig.accessKeyIdSet ??
        providerConfig.secretAccessKeySet
      );
    }

    // For Mux Gateway, check couponCodeSet
    if (provider === "mux-gateway") {
      return providerConfig.couponCodeSet ?? false;
    }

    // For other providers, check apiKeySet
    return providerConfig.apiKeySet ?? false;
  };

  const getFieldValue = (provider: string, field: string): string | undefined => {
    const providerConfig = config[provider] as Record<string, unknown> | undefined;
    if (!providerConfig) return undefined;
    const value = providerConfig[field];
    return typeof value === "string" ? value : undefined;
  };

  const isFieldSet = (provider: string, field: string, fieldConfig: FieldConfig): boolean => {
    if (fieldConfig.type === "secret") {
      // For apiKey, we have apiKeySet from the sanitized config
      if (field === "apiKey") return config[provider]?.apiKeySet ?? false;
      // For couponCode (mux-gateway), check couponCodeSet
      if (field === "couponCode") return config[provider]?.couponCodeSet ?? false;
      // For other secrets, check if the field exists in the raw config
      // Since we don't expose secret values, we assume they're not set if undefined
      const providerConfig = config[provider] as Record<string, unknown> | undefined;
      return providerConfig?.[`${field}Set`] === true;
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
            <button
              type="button"
              onClick={() => handleToggleProvider(provider)}
              className="hover:bg-hover flex w-full items-center justify-between px-4 py-3 text-left transition-colors"
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
            </button>

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
                            type={fieldConfig.type === "secret" ? "password" : "text"}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            placeholder={fieldConfig.placeholder}
                            className="bg-modal-bg border-border-medium focus:border-accent flex-1 rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void handleSaveEdit();
                              if (e.key === "Escape") handleCancelEdit();
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveEdit()}
                            disabled={saving}
                            className="p-1 text-green-500 hover:text-green-400"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={handleCancelEdit}
                            className="text-muted hover:text-foreground p-1"
                          >
                            <X className="h-4 w-4" />
                          </button>
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
                              <button
                                type="button"
                                onClick={() => void handleClearField(provider, fieldConfig.key)}
                                disabled={saving}
                                className="text-muted hover:text-error text-xs"
                              >
                                Clear
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                handleStartEdit(provider, fieldConfig.key, fieldConfig)
                              }
                              className="text-accent hover:text-accent-light text-xs"
                            >
                              {fieldIsSet || fieldValue ? "Change" : "Set"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
