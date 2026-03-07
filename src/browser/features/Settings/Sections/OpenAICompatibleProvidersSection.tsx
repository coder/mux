import { useCallback, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Plus, Trash2, X } from "lucide-react";

import type { OpenAICompatibleInstanceInfo, ProviderModelEntry } from "@/common/orpc/types";
import { useAPI } from "@/browser/contexts/API";
import { useOpenAICompatibleProviders } from "@/browser/hooks/useOpenAICompatibleProviders";
import { Button } from "@/browser/components/Button/Button";
import { getProviderModelEntryId } from "@/common/utils/providers/modelEntries";

interface OpenAICompatibleProvidersSectionProps {
  isExpanded?: boolean;
  onToggle?: () => void;
}

export function OpenAICompatibleProvidersSection({
  isExpanded: propIsExpanded,
  onToggle: propOnToggle,
}: OpenAICompatibleProvidersSectionProps) {
  const { api } = useAPI();
  const { config, refresh } = useOpenAICompatibleProviders();

  const [internalExpanded, setInternalExpanded] = useState(false);
  const isExpanded = propIsExpanded ?? internalExpanded;
  const onToggle = propOnToggle ?? (() => setInternalExpanded((v) => !v));

  const providers = config?.providers ?? [];
  const isConfigured = config?.isConfigured ?? false;

  const statusDotColor = isConfigured ? "bg-success" : "bg-border-medium";
  const statusDotTitle = isConfigured ? "Configured" : "Not configured";

  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newProvider, setNewProvider] = useState({
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
  });

  const [editProvider, setEditProvider] = useState({
    name: "",
    baseUrl: "",
    apiKey: "",
  });

  const [addingModelTo, setAddingModelTo] = useState<string | null>(null);
  const [newModelId, setNewModelId] = useState("");

  const handleAddModel = useCallback(
    async (instanceId: string) => {
      if (!api || !newModelId.trim()) return;

      const provider = providers.find((p) => p.id === instanceId);
      if (!provider) return;

      const currentModels = provider.models ?? [];
      const existingIds = currentModels.map((m) => getProviderModelEntryId(m));

      if (existingIds.includes(newModelId.trim())) {
        setError("Model already exists");
        return;
      }

      setSaving(true);
      setError(null);

      try {
        const newModel: ProviderModelEntry = { id: newModelId.trim() };
        const result = await api.openaiCompatibleProviders.setModels({
          instanceId,
          models: [...currentModels, newModel],
        });

        if (!result.success) {
          setError(result.error);
          setSaving(false);
          return;
        }

        setAddingModelTo(null);
        setNewModelId("");
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add model");
      } finally {
        setSaving(false);
      }
    },
    [api, newModelId, providers, refresh]
  );

  const handleRemoveModel = useCallback(
    async (instanceId: string, modelId: string) => {
      if (!api) return;

      const provider = providers.find((p) => p.id === instanceId);
      if (!provider) return;

      const currentModels = provider.models ?? [];
      const newModels = currentModels.filter((m) => getProviderModelEntryId(m) !== modelId);

      setSaving(true);
      setError(null);

      try {
        const result = await api.openaiCompatibleProviders.setModels({
          instanceId,
          models: newModels,
        });

        if (!result.success) {
          setError(result.error);
        } else {
          await refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove model");
      } finally {
        setSaving(false);
      }
    },
    [api, providers, refresh]
  );

  const handleAddProvider = useCallback(async () => {
    if (!api || !newProvider.id.trim() || !newProvider.name.trim() || !newProvider.baseUrl.trim()) {
      setError("Provider ID, name, and base URL are required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const result = await api.openaiCompatibleProviders.addProvider({
        id: newProvider.id.trim(),
        name: newProvider.name.trim(),
        baseUrl: newProvider.baseUrl.trim(),
        apiKey: newProvider.apiKey.trim() || undefined,
      });

      if (!result.success) {
        setError(result.error);
        setSaving(false);
        return;
      }

      setNewProvider({ id: "", name: "", baseUrl: "", apiKey: "" });
      setIsAdding(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add provider");
    } finally {
      setSaving(false);
    }
  }, [api, newProvider, refresh]);

  const handleUpdateProvider = useCallback(
    async (instanceId: string) => {
      if (!api || !editProvider.name.trim() || !editProvider.baseUrl.trim()) {
        setError("Name and base URL are required");
        return;
      }

      setSaving(true);
      setError(null);

      try {
        const result = await api.openaiCompatibleProviders.updateProvider({
          instanceId,
          updates: {
            name: editProvider.name.trim(),
            baseUrl: editProvider.baseUrl.trim(),
            apiKey: editProvider.apiKey.trim() || undefined,
          },
        });

        if (!result.success) {
          setError(result.error);
          setSaving(false);
          return;
        }

        setEditingId(null);
        setEditProvider({ name: "", baseUrl: "", apiKey: "" });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update provider");
      } finally {
        setSaving(false);
      }
    },
    [api, editProvider, refresh]
  );

  const handleDeleteProvider = useCallback(
    async (instanceId: string) => {
      if (!api) return;

      setSaving(true);
      setError(null);

      try {
        const result = await api.openaiCompatibleProviders.removeProvider({ instanceId });

        if (!result.success) {
          setError(result.error);
          setSaving(false);
          return;
        }

        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove provider");
      } finally {
        setSaving(false);
      }
    },
    [api, refresh]
  );

  const startEditing = (provider: OpenAICompatibleInstanceInfo) => {
    setEditingId(provider.id);
    setEditProvider({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: "",
    });
    setError(null);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditProvider({ name: "", baseUrl: "", apiKey: "" });
    setError(null);
  };

  return (
    <div className="border-border-medium bg-background-secondary overflow-hidden rounded-md border">
      <Button
        variant="ghost"
        onClick={onToggle}
        className="flex h-auto w-full items-center justify-between rounded-none px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          {isExpanded ? (
            <ChevronDown className="text-muted h-4 w-4" />
          ) : (
            <ChevronRight className="text-muted h-4 w-4" />
          )}
          <span className="text-foreground text-sm font-medium">OpenAI-Compatible Providers</span>
        </div>
        <div className={`h-2 w-2 rounded-full ${statusDotColor}`} title={statusDotTitle} />
      </Button>

      {isExpanded && (
        <div className="border-border-medium space-y-3 border-t px-4 py-3">
          <p className="text-muted text-xs">
            Configure OpenAI-compatible API endpoints (Together AI, Fireworks, LM Studio, etc.).
            Models are accessed via{" "}
            <code className="text-accent">openai-compatible:provider-id:model-name</code>.
          </p>

          {error && (
            <div className="text-error rounded-md bg-red-500/10 px-3 py-2 text-xs">{error}</div>
          )}

          {providers.map((provider: OpenAICompatibleInstanceInfo) => (
            <div
              key={provider.id}
              className="border-border-medium bg-background-tertiary rounded-md border p-3"
            >
              {editingId === provider.id ? (
                <div className="space-y-2">
                  <div>
                    <label className="text-muted mb-1 block text-xs">Display Name</label>
                    <input
                      type="text"
                      value={editProvider.name}
                      onChange={(e) => setEditProvider({ ...editProvider, name: e.target.value })}
                      className="bg-background border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 text-xs focus:outline-none"
                      placeholder="Together AI"
                    />
                  </div>
                  <div>
                    <label className="text-muted mb-1 block text-xs">Base URL</label>
                    <input
                      type="text"
                      value={editProvider.baseUrl}
                      onChange={(e) =>
                        setEditProvider({ ...editProvider, baseUrl: e.target.value })
                      }
                      className="bg-background border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                      placeholder="https://api.together.xyz/v1"
                    />
                  </div>
                  <div>
                    <label className="text-muted mb-1 block text-xs">API Key (optional)</label>
                    <input
                      type="password"
                      value={editProvider.apiKey}
                      onChange={(e) => setEditProvider({ ...editProvider, apiKey: e.target.value })}
                      className="bg-background border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                      placeholder="Leave empty to keep current key"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleUpdateProvider(provider.id)}
                      disabled={saving}
                    >
                      {saving ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3" />
                      )}
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={cancelEditing}>
                      <X className="h-3 w-3" />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-foreground text-sm font-medium">{provider.name}</div>
                    <div className="text-muted font-mono text-xs">{provider.baseUrl}</div>
                    <div className="text-muted text-xs">
                      ID: <code className="text-accent">{provider.id}</code>
                      {" • "}
                      {provider.apiKeySet ? "API key set" : "No API key"}
                      {" • "}
                      {provider.isEnabled ? "Enabled" : "Disabled"}
                    </div>

                    {/* Models section */}
                    <div className="mt-2 space-y-1">
                      <div className="text-muted text-xs font-medium">Models:</div>
                      {provider.models && provider.models.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {provider.models.map((model) => (
                            <span
                              key={getProviderModelEntryId(model)}
                              className="bg-background-secondary text-foreground flex items-center gap-1 rounded px-2 py-0.5 text-xs"
                            >
                              <code>{getProviderModelEntryId(model)}</code>
                              <button
                                onClick={() =>
                                  void handleRemoveModel(
                                    provider.id,
                                    getProviderModelEntryId(model)
                                  )
                                }
                                disabled={saving}
                                className="text-muted hover:text-error ml-1"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="text-muted text-xs italic">No models configured</div>
                      )}

                      {addingModelTo === provider.id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={newModelId}
                            onChange={(e) => setNewModelId(e.target.value)}
                            placeholder="model-id"
                            className="bg-background border-border-medium focus:border-accent rounded border px-2 py-0.5 text-xs"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void handleAddModel(provider.id);
                              if (e.key === "Escape") {
                                setAddingModelTo(null);
                                setNewModelId("");
                              }
                            }}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void handleAddModel(provider.id)}
                            disabled={saving || !newModelId.trim()}
                          >
                            <Check className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setAddingModelTo(null);
                              setNewModelId("");
                            }}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAddingModelTo(provider.id)}
                          className="text-muted hover:text-foreground h-auto px-1 py-0 text-xs"
                        >
                          <Plus className="h-3 w-3" />
                          Add model
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startEditing(provider)}
                      className="text-muted hover:text-foreground h-auto px-2 py-1 text-xs"
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleDeleteProvider(provider.id)}
                      disabled={saving}
                      className="text-muted hover:text-error h-auto px-2 py-1 text-xs"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {isAdding ? (
            <div className="border-border-medium bg-background-tertiary rounded-md border p-3">
              <div className="space-y-2">
                <div>
                  <label className="text-muted mb-1 block text-xs">Provider ID</label>
                  <input
                    type="text"
                    value={newProvider.id}
                    onChange={(e) => setNewProvider({ ...newProvider, id: e.target.value })}
                    className="bg-background border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                    placeholder="together-ai"
                  />
                  <p className="text-dim mt-1 text-xs">
                    Used in model strings: openai-compatible:
                    <span className="text-accent">together-ai</span>:model-id
                  </p>
                </div>
                <div>
                  <label className="text-muted mb-1 block text-xs">Display Name</label>
                  <input
                    type="text"
                    value={newProvider.name}
                    onChange={(e) => setNewProvider({ ...newProvider, name: e.target.value })}
                    className="bg-background border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 text-xs focus:outline-none"
                    placeholder="Together AI"
                  />
                </div>
                <div>
                  <label className="text-muted mb-1 block text-xs">Base URL</label>
                  <input
                    type="text"
                    value={newProvider.baseUrl}
                    onChange={(e) => setNewProvider({ ...newProvider, baseUrl: e.target.value })}
                    className="bg-background border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                    placeholder="https://api.together.xyz/v1"
                  />
                </div>
                <div>
                  <label className="text-muted mb-1 block text-xs">API Key</label>
                  <input
                    type="password"
                    value={newProvider.apiKey}
                    onChange={(e) => setNewProvider({ ...newProvider, apiKey: e.target.value })}
                    className="bg-background border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                    placeholder="Enter API key"
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void handleAddProvider()} disabled={saving}>
                    {saving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Add Provider
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setIsAdding(false);
                      setNewProvider({ id: "", name: "", baseUrl: "", apiKey: "" });
                      setError(null);
                    }}
                  >
                    <X className="h-3 w-3" />
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsAdding(true)}
              className="w-full"
            >
              <Plus className="h-3 w-3" />
              Add OpenAI-Compatible Provider
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
