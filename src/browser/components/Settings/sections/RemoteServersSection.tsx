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

interface LoadStatus {
  status: "idle" | "loading" | "success" | "error";
  message?: string;
}

interface Notice {
  type: "success" | "error";
  message: string;
}

type EditorState = { mode: "add" } | { mode: "edit"; id: string };

type EditorMode = EditorState["mode"];

interface ProjectPathSuggestion {
  path: string;
  label: string;
}

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

function getPathBasename(filePath: string): string {
  const trimmed = filePath.trim().replace(/[/\\]+$/g, "");
  if (!trimmed) {
    return "";
  }

  const segments = trimmed.split(/[/\\]/);
  const lastSegment = segments.at(-1);

  return lastSegment ?? trimmed;
}

function createPathSuggestion(filePath: string): ProjectPathSuggestion | null {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }

  const label = getPathBasename(trimmed) || trimmed;
  return { path: trimmed, label };
}

function getRemotePathPlaceholder(mapping: RemoteMuxServerProjectMapping): string {
  const localBasename = mapping.localProjectPath.trim()
    ? getPathBasename(mapping.localProjectPath)
    : "";
  if (!localBasename) {
    return "Remote project path";
  }

  return `Remote project path (e.g., /…/${localBasename})`;
}

export function RemoteServersSection() {
  const { api } = useAPI();

  const [servers, setServers] = useState<RemoteMuxServerListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const [pingById, setPingById] = useState<Record<string, PingStatus>>({});

  const [notice, setNotice] = useState<Notice | null>(null);

  const [editorState, setEditorState] = useState<EditorState | null>(null);

  const [draftConfig, setDraftConfig] = useState<RemoteMuxServerConfig>(() =>
    createDraftConfig(generateRemoteServerId())
  );
  const [draftHasAuthToken, setDraftHasAuthToken] = useState(false);
  const [authToken, setAuthToken] = useState<string>("");
  const [clearAuthTokenOnSave, setClearAuthTokenOnSave] = useState(false);
  const [saving, setSaving] = useState(false);

  const [localProjectSuggestions, setLocalProjectSuggestions] = useState<ProjectPathSuggestion[]>(
    []
  );
  const [localProjectsError, setLocalProjectsError] = useState<string | null>(null);
  const localProjectsRequestIdRef = useRef(0);

  const [remoteProjectSuggestions, setRemoteProjectSuggestions] = useState<ProjectPathSuggestion[]>(
    []
  );
  const [remoteProjectsStatus, setRemoteProjectsStatus] = useState<LoadStatus>({ status: "idle" });
  const remoteProjectsRequestIdRef = useRef(0);

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

  const loadLocalProjects = useCallback(async () => {
    if (!api) {
      setLocalProjectSuggestions([]);
      setLocalProjectsError(null);
      return;
    }

    const requestId = localProjectsRequestIdRef.current + 1;
    localProjectsRequestIdRef.current = requestId;

    try {
      const projects = await api.projects.list();
      if (localProjectsRequestIdRef.current !== requestId) {
        return;
      }

      const suggestions = projects
        .map(([projectPath]) => createPathSuggestion(projectPath))
        .filter((entry): entry is ProjectPathSuggestion => entry !== null)
        .sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));

      setLocalProjectSuggestions(suggestions);
      setLocalProjectsError(null);
    } catch (error) {
      if (localProjectsRequestIdRef.current !== requestId) {
        return;
      }

      setLocalProjectSuggestions([]);
      setLocalProjectsError(getErrorMessage(error));
    }
  }, [api]);

  const loadRemoteProjects = useCallback(
    async (serverId: string) => {
      if (!api) {
        setRemoteProjectSuggestions([]);
        setRemoteProjectsStatus({ status: "idle" });
        return;
      }

      const remoteServersApi: Partial<APIClient>["remoteServers"] = api.remoteServers;
      if (!remoteServersApi?.listRemoteProjects) {
        setRemoteProjectSuggestions([]);
        setRemoteProjectsStatus({
          status: "error",
          message: "Remote project suggestions are not supported by this backend.",
        });
        return;
      }

      const requestId = remoteProjectsRequestIdRef.current + 1;
      remoteProjectsRequestIdRef.current = requestId;

      setRemoteProjectsStatus({ status: "loading" });

      try {
        const result = await remoteServersApi.listRemoteProjects({ id: serverId });

        if (remoteProjectsRequestIdRef.current !== requestId) {
          return;
        }

        if (!result.success) {
          setRemoteProjectSuggestions([]);
          setRemoteProjectsStatus({ status: "error", message: result.error });
          return;
        }

        const suggestions = result.data
          .map((entry) => createPathSuggestion(entry.path))
          .filter((entry): entry is ProjectPathSuggestion => entry !== null)
          .sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));

        setRemoteProjectSuggestions(suggestions);
        setRemoteProjectsStatus({ status: "success" });
      } catch (error) {
        if (remoteProjectsRequestIdRef.current !== requestId) {
          return;
        }

        setRemoteProjectSuggestions([]);
        setRemoteProjectsStatus({ status: "error", message: getErrorMessage(error) });
      }
    },
    [api]
  );

  useEffect(() => {
    void loadServers();
    void loadLocalProjects();
  }, [loadLocalProjects, loadServers]);

  useEffect(() => {
    if (editorState?.mode !== "edit") {
      remoteProjectsRequestIdRef.current += 1;
      setRemoteProjectSuggestions([]);
      setRemoteProjectsStatus({ status: "idle" });
      return;
    }

    void loadRemoteProjects(editorState.id);
  }, [editorState, loadRemoteProjects]);

  const closeEditor = useCallback(() => {
    remoteProjectsRequestIdRef.current += 1;

    setEditorState(null);
    setDraftConfig(createDraftConfig(generateRemoteServerId()));
    setDraftHasAuthToken(false);
    setAuthToken("");
    setClearAuthTokenOnSave(false);
    setNotice(null);

    setRemoteProjectSuggestions([]);
    setRemoteProjectsStatus({ status: "idle" });
  }, []);

  const startAdd = useCallback(() => {
    remoteProjectsRequestIdRef.current += 1;

    setEditorState({ mode: "add" });
    setDraftConfig(createDraftConfig(generateRemoteServerId()));
    setDraftHasAuthToken(false);
    setAuthToken("");
    setClearAuthTokenOnSave(false);
    setNotice(null);

    setRemoteProjectSuggestions([]);
    setRemoteProjectsStatus({ status: "idle" });
  }, []);

  const startEdit = useCallback((entry: RemoteMuxServerListEntry) => {
    remoteProjectsRequestIdRef.current += 1;

    setEditorState({ mode: "edit", id: entry.config.id });
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
    setNotice(null);

    setRemoteProjectSuggestions([]);
    setRemoteProjectsStatus({ status: "idle" });
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

      setNotice(null);

      const remoteServersApi: Partial<APIClient>["remoteServers"] = api.remoteServers;
      if (!remoteServersApi) {
        setNotice({
          type: "error",
          message: "Remote servers are not supported by this backend.",
        });
        return;
      }

      try {
        const result = await remoteServersApi.remove({ id });
        if (!result.success) {
          setNotice({ type: "error", message: result.error });
          return;
        }
      } catch (error) {
        setNotice({ type: "error", message: getErrorMessage(error) });
        return;
      }

      if (editorState?.mode === "edit" && editorState.id === id) {
        closeEditor();
      }

      await loadServers();
    },
    [api, closeEditor, editorState, loadServers]
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

    if (!editorState) {
      return;
    }

    const remoteServersApi: Partial<APIClient>["remoteServers"] = api.remoteServers;
    if (!remoteServersApi) {
      setNotice({
        type: "error",
        message: "Remote servers are not supported by this backend.",
      });
      return;
    }

    const trimmedLabel = draftConfig.label.trim();
    if (!trimmedLabel) {
      setNotice({ type: "error", message: "Label is required." });
      return;
    }

    const trimmedBaseUrl = draftConfig.baseUrl.trim();
    if (!trimmedBaseUrl) {
      setNotice({ type: "error", message: "Base URL is required." });
      return;
    }

    setSaving(true);
    setNotice(null);

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
        setNotice({ type: "error", message: result.error });
        return;
      }

      await loadServers();
      closeEditor();
      setNotice({ type: "success", message: editorState.mode === "add" ? "Added." : "Saved." });
    } catch (error) {
      setNotice({ type: "error", message: getErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  }, [api, authToken, clearAuthTokenOnSave, closeEditor, draftConfig, editorState, loadServers]);

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

  const editorMode: EditorMode | null = editorState?.mode ?? null;
  const editorDatalistIdLocal = `remote-server-local-projects-${draftConfig.id}`;
  const editorDatalistIdRemote = `remote-server-remote-projects-${draftConfig.id}`;

  const editorForm = editorMode ? (
    <div className="grid gap-4">
      <div>
        <label
          className="text-muted mb-1 block text-xs"
          htmlFor={`remote-server-label-${draftConfig.id}`}
        >
          Label
        </label>
        <Input
          id={`remote-server-label-${draftConfig.id}`}
          value={draftConfig.label}
          onChange={(e) => setDraftConfig((prev) => ({ ...prev, label: e.target.value }))}
          placeholder="e.g., Work desktop"
        />
      </div>

      <div>
        <label
          className="text-muted mb-1 block text-xs"
          htmlFor={`remote-server-base-url-${draftConfig.id}`}
        >
          Base URL
        </label>
        <Input
          id={`remote-server-base-url-${draftConfig.id}`}
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
            <label
              className="text-muted mb-1 block text-xs"
              htmlFor={`remote-server-token-${draftConfig.id}`}
            >
              Auth token (optional)
            </label>
            <div className="text-muted mb-2 text-xs">
              {editorMode === "edit" && draftHasAuthToken
                ? "Token is configured locally. Leave blank to keep the existing token."
                : ""}
              {editorMode === "edit" && draftHasAuthToken ? " " : ""}
              Stored locally on this machine in{" "}
              <code className="font-mono">~/.mux/secrets.json</code>. The token expected by the
              remote server is configured on that machine in
              <code className="ml-1 font-mono">~/.mux/server.lock</code>.
              {clearAuthTokenOnSave && (
                <span className="text-destructive ml-2">Will clear the local token on save.</span>
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
              disabled={saving}
            >
              Clear local token
            </Button>
          )}
        </div>

        <Input
          id={`remote-server-token-${draftConfig.id}`}
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
              Map each local project path to the corresponding path on the remote server.
            </div>
            <div className="text-muted mt-1 text-xs">
              Local suggestions come from your configured projects.
              {editorMode === "edit" ? " Remote suggestions come from the remote server." : ""}
            </div>
            {localProjectsError && (
              <div className="text-destructive mt-1 text-xs">{localProjectsError}</div>
            )}
            {editorMode === "edit" && remoteProjectsStatus.status === "loading" && (
              <div className="text-muted mt-1 flex items-center gap-1 text-xs">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading remote projects…
              </div>
            )}
            {editorMode === "edit" &&
              remoteProjectsStatus.status === "error" &&
              remoteProjectsStatus.message && (
                <div className="text-destructive mt-1 text-xs">{remoteProjectsStatus.message}</div>
              )}
            {editorMode === "add" && (
              <div className="text-muted mt-1 text-xs">
                Tip: save the server first to load remote project suggestions.
              </div>
            )}
          </div>
          <Button variant="outline" size="xs" onClick={handleAddMapping} disabled={saving}>
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
                list={editorDatalistIdLocal}
              />
              <Input
                value={mapping.remoteProjectPath}
                onChange={(e) =>
                  handleMappingChange(idx, {
                    remoteProjectPath: e.target.value,
                  })
                }
                placeholder={
                  remoteProjectSuggestions.length > 0
                    ? "Remote project path"
                    : getRemotePathPlaceholder(mapping)
                }
                spellCheck={false}
                className="font-mono"
                list={editorDatalistIdRemote}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleRemoveMapping(idx)}
                className="text-muted hover:text-error h-10 w-10"
                aria-label="Remove mapping"
                disabled={saving}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        <datalist id={editorDatalistIdLocal}>
          {localProjectSuggestions.map((suggestion) => (
            <option key={suggestion.path} value={suggestion.path} label={suggestion.label} />
          ))}
        </datalist>
        <datalist id={editorDatalistIdRemote}>
          {remoteProjectSuggestions.map((suggestion) => (
            <option key={suggestion.path} value={suggestion.path} label={suggestion.label} />
          ))}
        </datalist>
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
  ) : null;

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
          <Button variant="outline" size="sm" onClick={startAdd} disabled={!api || saving}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>

        {notice && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-md px-3 py-2 text-sm",
              notice.type === "success"
                ? "bg-green-500/10 text-green-500"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {notice.type === "success" ? (
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>{notice.message}</span>
          </div>
        )}

        {editorMode === "add" && (
          <div className="border-border-medium bg-background-secondary space-y-4 rounded-md border p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-foreground text-sm font-medium">Add server</div>
                <div className="text-muted mt-0.5 text-xs">
                  ID: <code className="font-mono">{draftConfig.id}</code>
                </div>
              </div>

              <Button variant="ghost" size="sm" onClick={closeEditor} disabled={saving}>
                <X className="h-4 w-4" />
                Cancel
              </Button>
            </div>

            {editorForm}
          </div>
        )}

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

              const isEditingThis = editorState?.mode === "edit" && editorState.id === config.id;

              return (
                <div
                  key={config.id}
                  className={cn(
                    "border-border-medium bg-background-secondary rounded-md border p-3",
                    !enabled && "opacity-70"
                  )}
                >
                  {isEditingThis ? (
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-foreground text-sm font-medium">
                            Edit {config.label || config.id}
                          </div>
                          <div className="text-muted mt-0.5 text-xs">
                            ID: <code className="font-mono">{draftConfig.id}</code>
                          </div>
                        </div>

                        <Button variant="ghost" size="sm" onClick={closeEditor} disabled={saving}>
                          <X className="h-4 w-4" />
                          Cancel
                        </Button>
                      </div>

                      {editorForm}
                    </div>
                  ) : (
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
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(entry)}
                          disabled={saving}
                        >
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
                          disabled={!api || saving}
                          className="text-muted hover:text-error"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  )}

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
    </div>
  );
}
