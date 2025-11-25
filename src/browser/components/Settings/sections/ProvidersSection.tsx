import React, { useState, useEffect, useCallback } from "react";
import { ChevronDown, ChevronRight, Check, X } from "lucide-react";
import type { ProvidersConfigMap } from "../types";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";

export function ProvidersSection() {
  const [config, setConfig] = useState<ProvidersConfigMap>({});
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<{
    provider: string;
    field: "apiKey" | "baseUrl";
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

  const handleStartEdit = (provider: string, field: "apiKey" | "baseUrl") => {
    setEditingField({ provider, field });
    // For API key, start empty since we only show masked value
    // For baseUrl, show current value
    setEditValue(field === "baseUrl" ? (config[provider]?.baseUrl ?? "") : "");
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
      const keyPath = field === "apiKey" ? ["apiKey"] : ["baseUrl"];
      await window.api.providers.setProviderConfig(provider, keyPath, editValue);

      // Refresh config
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);
      setEditingField(null);
      setEditValue("");
    } finally {
      setSaving(false);
    }
  }, [editingField, editValue]);

  const handleClearBaseUrl = useCallback(async (provider: string) => {
    setSaving(true);
    try {
      await window.api.providers.setProviderConfig(provider, ["baseUrl"], "");
      const cfg = await window.api.providers.getConfig();
      setConfig(cfg);
    } finally {
      setSaving(false);
    }
  }, []);

  const isConfigured = (provider: string) => {
    return config[provider]?.apiKeySet ?? false;
  };

  return (
    <div className="space-y-2">
      <p className="text-muted mb-4 text-xs">
        Configure API keys and endpoints for AI providers. Keys are stored in{" "}
        <code className="text-accent">~/.mux/providers.jsonc</code>
      </p>

      {SUPPORTED_PROVIDERS.map((provider) => {
        const isExpanded = expandedProvider === provider;
        const providerConfig = config[provider];
        const configured = isConfigured(provider);

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
                <span className="text-foreground text-sm font-medium">
                  {PROVIDER_DISPLAY_NAMES[provider]}
                </span>
              </div>
              <div
                className={`h-2 w-2 rounded-full ${configured ? "bg-green-500" : "bg-border-medium"}`}
                title={configured ? "Configured" : "Not configured"}
              />
            </button>

            {/* Provider settings */}
            {isExpanded && (
              <div className="border-border-medium space-y-3 border-t px-4 py-3">
                {/* API Key */}
                <div>
                  <label className="text-muted mb-1 block text-xs">API Key</label>
                  {editingField?.provider === provider && editingField?.field === "apiKey" ? (
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        placeholder="Enter API key"
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
                        {providerConfig?.apiKeySet ? "••••••••" : "Not set"}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleStartEdit(provider, "apiKey")}
                        className="text-accent hover:text-accent-light text-xs"
                      >
                        {providerConfig?.apiKeySet ? "Change" : "Set"}
                      </button>
                    </div>
                  )}
                </div>

                {/* Base URL (optional) */}
                <div>
                  <label className="text-muted mb-1 block text-xs">
                    Base URL <span className="text-dim">(optional)</span>
                  </label>
                  {editingField?.provider === provider && editingField?.field === "baseUrl" ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        placeholder="https://api.example.com"
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
                        {providerConfig?.baseUrl ?? "Default"}
                      </span>
                      <div className="flex gap-2">
                        {providerConfig?.baseUrl && (
                          <button
                            type="button"
                            onClick={() => void handleClearBaseUrl(provider)}
                            disabled={saving}
                            className="text-muted hover:text-error text-xs"
                          >
                            Clear
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleStartEdit(provider, "baseUrl")}
                          className="text-accent hover:text-accent-light text-xs"
                        >
                          {providerConfig?.baseUrl ? "Change" : "Set"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
