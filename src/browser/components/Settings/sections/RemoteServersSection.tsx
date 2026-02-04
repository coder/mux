import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, Loader2, Pencil, Plus, Trash2, X, XCircle } from "lucide-react";

import { useAPI, type APIClient } from "@/browser/contexts/API";
import { Button } from "@/browser/components/ui/button";
import { Input } from "@/browser/components/ui/input";
import { Switch } from "@/browser/components/ui/switch";
import { cn } from "@/common/lib/utils";
import type { RemoteMuxServerConfig, RemoteMuxServerProjectMapping } from "@/common/types/project";

interface RemoteMuxServerListEntry {
  config: RemoteMuxServerConfig;
  hasAuthToken: boolean;
}

interface PingStatus {
  status: "idle" | "loading" | "success" | "error";
  message?: string;
}

interface EditorNotice {
  type: "success" | "error";
  message: string;
}

type EditorMode = "add" | "edit";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function generateRemoteServerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const random = Math.random().toString(16).slice(2);
  return `remote-${Date.now()}-${random}`;
}

function createBlankMapping(): RemoteMuxServerProjectMapping {
  return { localProjectPath: "", remoteProjectPath: "" };
}

function ensureAtLeastOneMapping(
  mappings: RemoteMuxServerProjectMapping[]
): RemoteMuxServerProjectMapping[] {
  if (mappings.length > 0) {
    return mappings;
  }

  return [createBlankMapping()];
}

function createDraftConfig(id: string): RemoteMuxServerConfig {
  return {
    id,
    label: "",
    baseUrl: "",
    enabled: true,
    projectMappings: [createBlankMapping()],
  };
}

function formatPingPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "OK";
  }

  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed ? `OK — ${trimmed}` : "OK";
  }

  if (typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const rawVersion =
      typeof record.git_describe === "string"
        ? record.git_describe.trim()
        : typeof record.version === "string"
          ? record.version.trim()
          : "";

    if (rawVersion) {
      const version =
        rawVersion.startsWith("v") || rawVersion.startsWith("V")
          ? `v${rawVersion.slice(1)}`
          : `v${rawVersion}`;
      return `OK — Mux ${version}`;
    }
  }

  try {
    const json = JSON.stringify(payload);
    if (json.length <= 200) {
      return `OK — ${json}`;
    }

    return `OK — ${json.slice(0, 200)}…`;
  } catch {
    return "OK";
  }
}

export function RemoteServersSection() {
  const { api } = useAPI();

  const [servers, setServers] = useState<RemoteMuxServerListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const [pingById, setPingById] = useState<Record<string, PingStatus>>({});

  const [editorMode, setEditorMode] = useState<EditorMode>("add");
  const [draftConfig, setDraftConfig] = useState<RemoteMuxServerConfig>(() =>
    createDraftConfig(generateRemoteServerId())
  );
  const [draftHasAuthToken, setDraftHasAuthToken] = useState(false);
  const [authToken, setAuthToken] = useState<string>("");
  const [clearAuthTokenOnSave, setClearAuthTokenOnSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorNotice, setEditorNotice] = useState<EditorNotice | null>(null);

  const loadServers = useCallback(async () => {
    if (!api) {
      setServers([]);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setLoading(true);
    setLoadError(null);

    try {
      const remoteServersApi: Partial<APIClient>["remoteServers"] = api.remoteServers;
      if (!remoteServersApi) {
        if (requestIdRef.current !== requestId) {
          return;
        }

        setServers([]);
        return;
      }

      const result = (await remoteServersApi.list()) as RemoteMuxServerListEntry[];
      if (requestIdRef.current !== requestId) {
        return;
      }

      setServers(result);
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }

      setLoadError(getErrorMessage(error));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const resetEditorToAdd = useCallback(() => {
    setEditorMode("add");
    setDraftConfig(createDraftConfig(generateRemoteServerId()));
    setDraftHasAuthToken(false);
    setAuthToken("");
    setClearAuthTokenOnSave(false);
    setEditorNotice(null);
  }, []);

  const startEdit = useCallback((entry: RemoteMuxServerListEntry) => {
    setEditorMode("edit");
    setDraftConfig({
      ...entry.config,
      enabled: entry.config.enabled !== false,
      projectMappings: ensureAtLeastOneMapping(
        entry.config.projectMappings.map((mapping) => ({ ...mapping }))
      ),
    });
    setDraftHasAuthToken(entry.hasAuthToken);
    setAuthToken("");
    setClearAuthTokenOnSave(false);
    setEditorNotice(null);
  }, []);

  const handleRemove = useCallback(
    async (id: string) => {
      if (!api) {
        return;
      }

      const confirmed = window.confirm("Remove this remote server?");
      if (!confirmed) {
        return;
      }

      setEditorNotice(null);

      const remoteServersApi: Partial<APIClient>["remoteServers"] = api.remoteServers;
      if (!remoteServersApi) {
        setEditorNotice({
          type: "error",
          message: "Remote servers are not supported by this backend.",
        });
        return;
      }

      try {
        const result = await remoteServersApi.remove({ id });
        if (!result.success) {
          setEditorNotice({ type: "error", message: result.error });
          return;
        }
      } catch (error) {
        setEditorNotice({ type: "error", message: getErrorMessage(error) });
        return;
      }

      if (editorMode === "edit" && draftConfig.id === id) {
        resetEditorToAdd();
      }

      await loadServers();
    },
    [api, draftConfig.id, editorMode, loadServers, resetEditorToAdd]
  );

  const handlePing = useCallback(
    async (id: string) => {
      if (!api) {
        return;
      }

      setPingById((prev) => ({
        ...prev,
        [id]: { status: "loading" },
      }));

      const remoteServersApi: Partial<APIClient>["remoteServers"] = api.remoteServers;
      if (!remoteServersApi) {
        setPingById((prev) => ({
          ...prev,
          [id]: {
            status: "error",
            message: "Remote servers are not supported by this backend.",
          },
        }));
        return;
      }

      try {
        const result = await remoteServersApi.ping({ id });

        if (result.success) {
          setPingById((prev) => ({
            ...prev,
            [id]: { status: "success", message: formatPingPayload(result.data.version) },
          }));
        } else {
          setPingById((prev) => ({
            ...prev,
            [id]: { status: "error", message: result.error },
          }));
        }
      } catch (error) {
        setPingById((prev) => ({
          ...prev,
          [id]: { status: "error", message: getErrorMessage(error) },
        }));
      }
    },
    [api]
  );

  const handleSave = useCallback(async () => {
    if (!api) {
      return;
    }

    const remoteServersApi: Partial<APIClient>["remoteServers"] = api.remoteServers;
    if (!remoteServersApi) {
      setEditorNotice({
        type: "error",
        message: "Remote servers are not supported by this backend.",
      });
      return;
    }

    const trimmedLabel = draftConfig.label.trim();
    if (!trimmedLabel) {
      setEditorNotice({ type: "error", message: "Label is required." });
      return;
    }

    const trimmedBaseUrl = draftConfig.baseUrl.trim();
    if (!trimmedBaseUrl) {
      setEditorNotice({ type: "error", message: "Base URL is required." });
      return;
    }

    setSaving(true);
    setEditorNotice(null);

    const tokenToSend = clearAuthTokenOnSave ? "" : authToken.trim() ? authToken : undefined;

    try {
      const result = await remoteServersApi.upsert({
        config: {
          ...draftConfig,
          label: trimmedLabel,
          baseUrl: trimmedBaseUrl,
          projectMappings: draftConfig.projectMappings.map((mapping) => ({ ...mapping })),
        },
        authToken: tokenToSend,
      });

      if (!result.success) {
        setEditorNotice({ type: "error", message: result.error });
        return;
      }

      await loadServers();

      if (editorMode === "edit") {
        setDraftHasAuthToken((prev) => {
          if (tokenToSend === "") {
            return false;
          }

          if (typeof tokenToSend === "string") {
            return true;
          }

          return prev;
        });
      } else {
        // New drafts start with an unknown token state until saved.
        setDraftHasAuthToken(false);
      }

      setEditorNotice({ type: "success", message: "Saved." });
      setAuthToken("");
      setClearAuthTokenOnSave(false);

      if (editorMode === "add") {
        setDraftConfig(createDraftConfig(generateRemoteServerId()));
      }
    } catch (error) {
      setEditorNotice({ type: "error", message: getErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  }, [api, authToken, clearAuthTokenOnSave, draftConfig, editorMode, loadServers]);

  const handleMappingChange = useCallback(
    (index: number, next: Partial<RemoteMuxServerProjectMapping>) => {
      setDraftConfig((prev) => {
        const nextMappings = prev.projectMappings.map((mapping, idx) =>
          idx === index ? { ...mapping, ...next } : mapping
        );
        return { ...prev, projectMappings: nextMappings };
      });
    },
    []
  );

  const handleAddMapping = useCallback(() => {
    setDraftConfig((prev) => ({
      ...prev,
      projectMappings: [...prev.projectMappings, createBlankMapping()],
    }));
  }, []);

  const handleRemoveMapping = useCallback((index: number) => {
    setDraftConfig((prev) => {
      const next = prev.projectMappings.filter((_, idx) => idx !== index);
      return {
        ...prev,
        projectMappings: ensureAtLeastOneMapping(next),
      };
    });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Remote servers</h3>
        <p className="text-muted text-xs">
          Configure remote mux API servers and map remote project paths to local ones.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-foreground text-sm font-medium">Configured</h4>
          <Button variant="outline" size="sm" onClick={resetEditorToAdd}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        {loadError && (
          <div className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {loading ? (
          <div className="text-muted flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : servers.length === 0 ? (
          <div className="text-muted text-sm">No remote servers configured.</div>
        ) : (
          <div className="space-y-2">
            {servers.map((entry) => {
              const { config } = entry;
              const enabled = config.enabled !== false;
              const pingStatus = pingById[config.id] ?? { status: "idle" };

              return (
                <div
                  key={config.id}
                  className={cn(
                    "border-border-medium bg-background-secondary rounded-md border p-3",
                    !enabled && "opacity-70"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground truncate text-sm font-medium">
                        {config.label || config.id}
                      </div>
                      <div className="text-muted mt-0.5 font-mono text-xs break-all">
                        {config.baseUrl}
                      </div>
                      <div className="text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <span>Enabled: {enabled ? "Yes" : "No"}</span>
                        <span>Mappings: {config.projectMappings.length}</span>
                        <span>Token: {entry.hasAuthToken ? "Configured" : "—"}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => startEdit(entry)}>
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handlePing(config.id)}
                        disabled={!api || pingStatus.status === "loading"}
                      >
                        {pingStatus.status === "loading" && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        Ping
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRemove(config.id)}
                        disabled={!api}
                        className="text-muted hover:text-error"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                      </Button>
                    </div>
                  </div>

                  {pingStatus.status === "success" && pingStatus.message && (
                    <div className="mt-2 flex items-start gap-1.5 text-xs text-green-500">
                      <CheckCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{pingStatus.message}</span>
                    </div>
                  )}
                  {pingStatus.status === "error" && pingStatus.message && (
                    <div className="text-destructive mt-2 flex items-start gap-1.5 text-xs">
                      <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{pingStatus.message}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-border-medium bg-background-secondary space-y-4 rounded-md border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-foreground text-sm font-medium">
              {editorMode === "add" ? "Add server" : "Edit server"}
            </div>
            <div className="text-muted mt-0.5 text-xs">
              ID: <code className="font-mono">{draftConfig.id}</code>
            </div>
          </div>

          {editorMode === "edit" && (
            <Button variant="ghost" size="sm" onClick={resetEditorToAdd}>
              <X className="h-4 w-4" />
              Cancel
            </Button>
          )}
        </div>

        {editorNotice && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-md px-3 py-2 text-sm",
              editorNotice.type === "success"
                ? "bg-green-500/10 text-green-500"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {editorNotice.type === "success" ? (
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>{editorNotice.message}</span>
          </div>
        )}

        <div className="grid gap-4">
          <div>
            <label className="text-muted mb-1 block text-xs" htmlFor="remote-server-label">
              Label
            </label>
            <Input
              id="remote-server-label"
              value={draftConfig.label}
              onChange={(e) => setDraftConfig((prev) => ({ ...prev, label: e.target.value }))}
              placeholder="e.g., Work desktop"
            />
          </div>

          <div>
            <label className="text-muted mb-1 block text-xs" htmlFor="remote-server-base-url">
              Base URL
            </label>
            <Input
              id="remote-server-base-url"
              value={draftConfig.baseUrl}
              onChange={(e) =>
                setDraftConfig((prev) => ({
                  ...prev,
                  baseUrl: e.target.value,
                }))
              }
              placeholder="https://example.com"
              spellCheck={false}
              className="font-mono"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-foreground text-sm">Enabled</div>
              <div className="text-muted mt-0.5 text-xs">
                Disabled servers are ignored for remote workspaces.
              </div>
            </div>
            <Switch
              checked={draftConfig.enabled !== false}
              onCheckedChange={(checked) =>
                setDraftConfig((prev) => ({
                  ...prev,
                  enabled: checked,
                }))
              }
              aria-label="Toggle remote server enabled"
            />
          </div>

          <div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <label className="text-muted mb-1 block text-xs" htmlFor="remote-server-token">
                  Auth token (optional)
                </label>
                <div className="text-muted mb-2 text-xs">
                  {editorMode === "edit" && draftHasAuthToken
                    ? "Token is configured. Leave blank to keep the existing token."
                    : "Stored in ~/.mux/secrets.json."}
                  {clearAuthTokenOnSave && (
                    <span className="text-destructive ml-2">Will be cleared on save.</span>
                  )}
                </div>
              </div>

              {editorMode === "edit" && draftHasAuthToken && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    setAuthToken("");
                    setClearAuthTokenOnSave(true);
                  }}
                >
                  Clear token
                </Button>
              )}
            </div>

            <Input
              id="remote-server-token"
              type="password"
              value={authToken}
              onChange={(e) => {
                setAuthToken(e.target.value);
                setClearAuthTokenOnSave(false);
              }}
              placeholder={editorMode === "edit" ? "Enter new token" : "Enter token"}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-foreground text-sm">Project mappings</div>
                <div className="text-muted mt-0.5 text-xs">
                  Each mapping links a remote project path to a local project path.
                </div>
              </div>
              <Button variant="outline" size="xs" onClick={handleAddMapping}>
                <Plus className="h-3.5 w-3.5" />
                Add mapping
              </Button>
            </div>

            <div className="mt-3 space-y-2">
              {draftConfig.projectMappings.map((mapping, idx) => (
                <div key={idx} className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
                  <Input
                    value={mapping.localProjectPath}
                    onChange={(e) =>
                      handleMappingChange(idx, {
                        localProjectPath: e.target.value,
                      })
                    }
                    placeholder="Local project path"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <Input
                    value={mapping.remoteProjectPath}
                    onChange={(e) =>
                      handleMappingChange(idx, {
                        remoteProjectPath: e.target.value,
                      })
                    }
                    placeholder="Remote project path"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveMapping(idx)}
                    className="text-muted hover:text-error h-10 w-10"
                    aria-label="Remove mapping"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void handleSave()} disabled={!api || saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>

            {editorMode === "edit" && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleRemove(draftConfig.id)}
                disabled={!api || saving}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
