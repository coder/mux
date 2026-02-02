import React, { useCallback, useEffect, useState } from "react";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import assert from "@/common/utils/assert";
import {
  Trash2,
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  Plus,
  Pencil,
  Check,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/browser/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { createEditKeyHandler } from "@/browser/utils/ui/keybinds";
import { Switch } from "@/browser/components/ui/switch";
import { cn } from "@/common/lib/utils";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import type {
  CachedMCPTestResult,
  MCPConfigDiagnostics,
  MCPHeaderValue,
  MCPServerInfo,
  MCPServerTransport,
} from "@/common/types/mcp";
import { useMCPTestCache } from "@/browser/hooks/useMCPTestCache";
import { MCPHeadersEditor } from "@/browser/components/MCPHeadersEditor";
import {
  mcpHeaderRowsToRecord,
  mcpHeadersRecordToRows,
  type MCPHeaderRow,
} from "@/browser/utils/mcpHeaders";
import { ToolSelector } from "@/browser/components/ToolSelector";

const MCP_SERVER_SECTION_ID_PREFIX = "mcp-server-settings";

type McpAllowUserDefined =
  | {
      stdio: boolean;
      remote: boolean;
    }
  | undefined;

function formatDiagnosticsSummary(diag: MCPConfigDiagnostics): {
  parseSummary: string | null;
  validationSummary: string | null;
} {
  const parseSummary =
    diag.parseErrors.length === 0
      ? null
      : diag.parseErrors.length === 1
        ? `1 parse error in ${diag.filePath}`
        : `${diag.parseErrors.length} parse errors in ${diag.filePath}`;

  const validationSummary =
    diag.validationErrors.length === 0
      ? null
      : diag.validationErrors.length === 1
        ? "1 validation error"
        : `${diag.validationErrors.length} validation errors`;

  return { parseSummary, validationSummary };
}

/** Component for managing tool allowlist for a single MCP server */
const ToolAllowlistSection: React.FC<{
  serverName: string;
  availableTools: string[];
  currentAllowlist?: string[];
  testedAt: number;
  onSaveAllowlist: (toolAllowlist: string[]) => Promise<{ success: boolean; error?: string }>;
}> = ({ serverName: _serverName, availableTools, currentAllowlist, testedAt, onSaveAllowlist }) => {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  // Always use an array internally - undefined from props means all tools allowed
  const [localAllowlist, setLocalAllowlist] = useState<string[]>(
    () => currentAllowlist ?? [...availableTools]
  );

  // Sync local state when prop changes
  useEffect(() => {
    setLocalAllowlist(currentAllowlist ?? [...availableTools]);
  }, [currentAllowlist, availableTools]);

  const allAllowed = localAllowlist.length === availableTools.length;
  const allDisabled = localAllowlist.length === 0;

  const handleToggleTool = useCallback(
    async (toolName: string, allowed: boolean) => {
      const newAllowlist = allowed
        ? [...localAllowlist, toolName]
        : localAllowlist.filter((t) => t !== toolName);

      // Optimistic update
      setLocalAllowlist(newAllowlist);
      setSaving(true);

      try {
        const result = await onSaveAllowlist(newAllowlist);
        if (!result.success) {
          setLocalAllowlist(currentAllowlist ?? [...availableTools]);
          console.error("Failed to update tool allowlist:", result.error);
        }
      } catch (err) {
        setLocalAllowlist(currentAllowlist ?? [...availableTools]);
        console.error("Failed to update tool allowlist:", err);
      } finally {
        setSaving(false);
      }
    },
    [onSaveAllowlist, localAllowlist, currentAllowlist, availableTools]
  );

  const handleAllowAll = useCallback(async () => {
    if (allAllowed) return;

    const newAllowlist = [...availableTools];
    setLocalAllowlist(newAllowlist);
    setSaving(true);

    try {
      const result = await onSaveAllowlist(newAllowlist);
      if (!result.success) {
        setLocalAllowlist(currentAllowlist ?? [...availableTools]);
        console.error("Failed to clear tool allowlist:", result.error);
      }
    } catch (err) {
      setLocalAllowlist(currentAllowlist ?? [...availableTools]);
      console.error("Failed to clear tool allowlist:", err);
    } finally {
      setSaving(false);
    }
  }, [onSaveAllowlist, allAllowed, currentAllowlist, availableTools]);

  const handleSelectNone = useCallback(async () => {
    if (allDisabled) return;

    setLocalAllowlist([]);
    setSaving(true);

    try {
      const result = await onSaveAllowlist([]);
      if (!result.success) {
        setLocalAllowlist(currentAllowlist ?? [...availableTools]);
        console.error("Failed to set empty tool allowlist:", result.error);
      }
    } catch (err) {
      setLocalAllowlist(currentAllowlist ?? [...availableTools]);
      console.error("Failed to set empty tool allowlist:", err);
    } finally {
      setSaving(false);
    }
  }, [onSaveAllowlist, allDisabled, currentAllowlist, availableTools]);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-muted hover:text-foreground flex items-center gap-1 text-xs"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>
          Tools: {localAllowlist.length}/{availableTools.length}
        </span>
        <span className="text-muted/60 ml-1">({formatRelativeTime(testedAt)})</span>
        {saving && <Loader2 className="ml-1 h-3 w-3 animate-spin" />}
      </button>

      {expanded && (
        <div className="mt-2">
          <ToolSelector
            availableTools={availableTools}
            allowedTools={localAllowlist}
            onToggle={(tool, allowed) => void handleToggleTool(tool, allowed)}
            onSelectAll={() => void handleAllowAll()}
            onSelectNone={() => void handleSelectNone()}
            disabled={saving}
          />
        </div>
      )}
    </div>
  );
};

interface McpServersEditorProps {
  title: string;
  description?: React.ReactNode;

  disabledByPolicy: boolean;
  mcpAllowUserDefined: McpAllowUserDefined;

  projectSecretKeys: string[];

  testCachePrefix?: string;

  testCache: Record<string, CachedMCPTestResult>;
  cacheTestResult: (name: string, result: CachedMCPTestResult["result"]) => void;
  clearTestResult: (name: string) => void;

  loadDiagnostics?: () => Promise<MCPConfigDiagnostics>;

  loadServers: () => Promise<Record<string, MCPServerInfo>>;

  addOrUpdateServer: (input: {
    name: string;
    transport: MCPServerTransport;
    value: string;
    headers?: Record<string, MCPHeaderValue>;
  }) => Promise<{ success: boolean; error?: string }>;

  removeServer: (name: string) => Promise<{ success: boolean; error?: string }>;

  setEnabled: (name: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;

  testServerByName: (name: string) => Promise<CachedMCPTestResult["result"]>;

  testServerAdhoc: (input: {
    transport: MCPServerTransport;
    value: string;
    headers?: Record<string, MCPHeaderValue>;
  }) => Promise<CachedMCPTestResult["result"]>;

  setToolAllowlist: (
    name: string,
    toolAllowlist: string[]
  ) => Promise<{ success: boolean; error?: string }>;
}

const McpServersEditor: React.FC<McpServersEditorProps> = (props) => {
  const {
    title,
    description,
    disabledByPolicy,
    mcpAllowUserDefined,
    projectSecretKeys,
    testCachePrefix,
    testCache,
    cacheTestResult,
    clearTestResult,
    loadDiagnostics,
    loadServers,
    addOrUpdateServer,
    removeServer,
    setEnabled,
    testServerByName,
    testServerAdhoc,
    setToolAllowlist,
  } = props;

  const cacheKey = useCallback(
    (serverName: string) => (testCachePrefix ? `${testCachePrefix}:${serverName}` : serverName),
    [testCachePrefix]
  );

  // Core state
  const [servers, setServers] = useState<Record<string, MCPServerInfo>>({});
  const [diagnostics, setDiagnostics] = useState<MCPConfigDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Test state with caching
  const [testingServer, setTestingServer] = useState<string | null>(null);

  interface EditableServer {
    name: string;
    transport: MCPServerTransport;
    /** command (stdio) or url (http/sse/auto) */
    value: string;
    /** Headers (http/sse/auto only) */
    headersRows: MCPHeaderRow[];
  }

  // Add form state

  // Ensure the "Add server" transport select always points to a policy-allowed value.
  useEffect(() => {
    const allowUserDefined = mcpAllowUserDefined;
    if (!allowUserDefined) {
      return;
    }

    const isAllowed = (transport: MCPServerTransport): boolean => {
      if (transport === "stdio") {
        return allowUserDefined.stdio;
      }

      return allowUserDefined.remote;
    };

    setNewServer((prev) => {
      if (isAllowed(prev.transport)) {
        return prev;
      }

      const fallback: MCPServerTransport | null = allowUserDefined.stdio
        ? "stdio"
        : allowUserDefined.remote
          ? "http"
          : null;

      if (!fallback) {
        return prev;
      }

      return { ...prev, transport: fallback, value: "", headersRows: [] };
    });
  }, [mcpAllowUserDefined]);

  const [newServer, setNewServer] = useState<EditableServer>({
    name: "",
    transport: "stdio",
    value: "",
    headersRows: [],
  });
  const [addingServer, setAddingServer] = useState(false);
  const [testingNew, setTestingNew] = useState(false);
  const [newTestResult, setNewTestResult] = useState<CachedMCPTestResult | null>(null);

  // Edit state
  const [editing, setEditing] = useState<EditableServer | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);

    try {
      const [mcpResult, diag] = await Promise.all([
        loadServers(),
        loadDiagnostics ? loadDiagnostics() : Promise.resolve(null),
      ]);

      setServers(mcpResult ?? {});
      setDiagnostics(diag);
      setError(null);
    } catch (err) {
      setServers({});
      setDiagnostics(null);
      setError(err instanceof Error ? err.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, [loadServers, loadDiagnostics]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Clear new-server test result when transport/value/headers change
  useEffect(() => {
    setNewTestResult(null);
  }, [newServer.transport, newServer.value, newServer.headersRows]);

  const handleRemove = useCallback(
    async (name: string) => {
      setLoading(true);
      try {
        const result = await removeServer(name);
        if (!result.success) {
          setError(result.error ?? "Failed to remove MCP server");
        } else {
          clearTestResult(cacheKey(name));
          await refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove MCP server");
      } finally {
        setLoading(false);
      }
    },
    [removeServer, clearTestResult, cacheKey, refresh]
  );

  const handleToggleEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      // Optimistic update
      setServers((prev) => ({
        ...prev,
        [name]: { ...prev[name], disabled: !enabled },
      }));

      try {
        const result = await setEnabled(name, enabled);
        if (!result.success) {
          // Revert on error
          setServers((prev) => ({
            ...prev,
            [name]: { ...prev[name], disabled: enabled },
          }));
          setError(result.error ?? "Failed to update server");
        }
      } catch (err) {
        // Revert on error
        setServers((prev) => ({
          ...prev,
          [name]: { ...prev[name], disabled: enabled },
        }));
        setError(err instanceof Error ? err.message : "Failed to update server");
      }
    },
    [setEnabled]
  );

  const handleTest = useCallback(
    async (name: string) => {
      setTestingServer(name);
      try {
        const result = await testServerByName(name);
        cacheTestResult(cacheKey(name), result);
      } catch (err) {
        cacheTestResult(cacheKey(name), {
          success: false,
          error: err instanceof Error ? err.message : "Test failed",
        });
      } finally {
        setTestingServer(null);
      }
    },
    [testServerByName, cacheTestResult, cacheKey]
  );

  const handleTestNewServer = useCallback(async () => {
    if (!newServer.value.trim()) {
      return;
    }

    setTestingNew(true);
    setNewTestResult(null);

    try {
      const { headers, validation } =
        newServer.transport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(newServer.headersRows, {
              knownSecretKeys: new Set(projectSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

      const result = await testServerAdhoc({
        transport: newServer.transport,
        value: newServer.value.trim(),
        headers,
      });

      setNewTestResult({ result, testedAt: Date.now() });
    } catch (err) {
      setNewTestResult({
        result: { success: false, error: err instanceof Error ? err.message : "Test failed" },
        testedAt: Date.now(),
      });
    } finally {
      setTestingNew(false);
    }
  }, [newServer, projectSecretKeys, testServerAdhoc]);

  const handleAddServer = useCallback(async () => {
    if (!newServer.name.trim() || !newServer.value.trim()) {
      return;
    }

    setAddingServer(true);
    setError(null);

    try {
      const { headers, validation } =
        newServer.transport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(newServer.headersRows, {
              knownSecretKeys: new Set(projectSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

      const result = await addOrUpdateServer({
        name: newServer.name.trim(),
        transport: newServer.transport,
        value: newServer.value.trim(),
        headers,
      });

      if (!result.success) {
        setError(result.error ?? "Failed to add MCP server");
      } else {
        // Cache the test result if we have one
        if (newTestResult?.result.success) {
          cacheTestResult(cacheKey(newServer.name.trim()), newTestResult.result);
        }

        setNewServer({ name: "", transport: "stdio", value: "", headersRows: [] });
        setNewTestResult(null);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add MCP server");
    } finally {
      setAddingServer(false);
    }
  }, [
    newServer,
    newTestResult,
    projectSecretKeys,
    addOrUpdateServer,
    cacheTestResult,
    cacheKey,
    refresh,
  ]);

  const handleStartEdit = useCallback((name: string, entry: MCPServerInfo) => {
    setEditing({
      name,
      transport: entry.transport,
      value: entry.transport === "stdio" ? entry.command : entry.url,
      headersRows: entry.transport === "stdio" ? [] : mcpHeadersRecordToRows(entry.headers),
    });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editing?.value.trim()) {
      return;
    }

    setSavingEdit(true);
    setError(null);

    try {
      const { headers, validation } =
        editing.transport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(editing.headersRows, {
              knownSecretKeys: new Set(projectSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

      const result = await addOrUpdateServer({
        name: editing.name,
        transport: editing.transport,
        value: editing.value.trim(),
        headers,
      });

      if (!result.success) {
        setError(result.error ?? "Failed to update MCP server");
      } else {
        // Clear cached test result since config changed
        clearTestResult(cacheKey(editing.name));
        setEditing(null);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update MCP server");
    } finally {
      setSavingEdit(false);
    }
  }, [editing, projectSecretKeys, addOrUpdateServer, clearTestResult, cacheKey, refresh]);

  const serverDisplayValue = (entry: MCPServerInfo): string =>
    entry.transport === "stdio" ? entry.command : entry.url;

  const newHeadersValidation =
    newServer.transport === "stdio"
      ? { errors: [], warnings: [] }
      : mcpHeaderRowsToRecord(newServer.headersRows, {
          knownSecretKeys: new Set(projectSecretKeys),
        }).validation;

  const canAdd =
    newServer.name.trim().length > 0 &&
    newServer.value.trim().length > 0 &&
    (newServer.transport === "stdio" || newHeadersValidation.errors.length === 0);

  const canTest =
    newServer.value.trim().length > 0 &&
    (newServer.transport === "stdio" || newHeadersValidation.errors.length === 0);

  const editHeadersValidation =
    editing && editing.transport !== "stdio"
      ? mcpHeaderRowsToRecord(editing.headersRows, {
          knownSecretKeys: new Set(projectSecretKeys),
        }).validation
      : { errors: [], warnings: [] };

  const idPrefix = `${MCP_SERVER_SECTION_ID_PREFIX}-${title.replace(/\s+/g, "-").toLowerCase()}`;
  // Avoid invalid IDs when title has weird characters.
  assert(idPrefix.length > 0, "idPrefix must be non-empty");

  const hasDiagnostics = Boolean(
    diagnostics && (diagnostics.parseErrors.length > 0 || diagnostics.validationErrors.length > 0)
  );

  return (
    <div>
      <div className="mb-3">
        <h3 className="text-foreground mb-1 text-sm font-medium">{title}</h3>
        {description}
      </div>

      {disabledByPolicy ? (
        <p className="text-muted py-2 text-sm">MCP servers are disabled by policy.</p>
      ) : (
        <>
          {hasDiagnostics && diagnostics && (
            <div
              className={cn(
                "border-border-medium mb-3 rounded-md border px-3 py-2 text-xs",
                diagnostics.parseErrors.length > 0
                  ? "bg-destructive/10 text-destructive"
                  : "bg-yellow-500/10 text-yellow-500"
              )}
            >
              {(() => {
                const summary = formatDiagnosticsSummary(diagnostics);

                return (
                  <>
                    {summary.parseSummary && (
                      <div className="font-medium">{summary.parseSummary}</div>
                    )}
                    {summary.validationSummary && (
                      <div className="font-medium">{summary.validationSummary}</div>
                    )}

                    <div className="mt-1 font-mono break-all opacity-80">
                      {diagnostics.filePath}
                    </div>

                    {diagnostics.parseErrors.slice(0, 3).map((e, idx) => (
                      <div key={`${idx}-${e.offset}`} className="mt-1 opacity-90">
                        {e.message} (offset {e.offset})
                      </div>
                    ))}

                    {diagnostics.validationErrors.slice(0, 3).map((e, idx) => (
                      <div key={`${idx}-${e.serverName ?? "unknown"}`} className="mt-1 opacity-90">
                        {e.serverName ? `${e.serverName}: ` : ""}
                        {e.message}
                      </div>
                    ))}

                    {(diagnostics.parseErrors.length > 3 ||
                      diagnostics.validationErrors.length > 3) && (
                      <div className="mt-1 opacity-80">…</div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {error && (
            <div className="bg-destructive/10 text-destructive mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm">
              <XCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {/* Server list */}
          <div className="space-y-2">
            {loading ? (
              <div className="text-muted flex items-center gap-2 py-4 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading servers…
              </div>
            ) : Object.keys(servers).length === 0 ? (
              <p className="text-muted py-2 text-sm">No MCP servers configured yet.</p>
            ) : (
              Object.entries(servers).map(([name, entry]) => {
                const isTesting = testingServer === name;
                const cached = testCache[cacheKey(name)];
                const isEditing = editing?.name === name;
                const isEnabled = !entry.disabled;
                return (
                  <div
                    key={name}
                    className="border-border-medium bg-background-secondary overflow-hidden rounded-md border"
                  >
                    <div className="flex items-start gap-3 px-3 py-2.5">
                      <Switch
                        checked={isEnabled}
                        onCheckedChange={(checked) => void handleToggleEnabled(name, checked)}
                        title={isEnabled ? "Disable server" : "Enable server"}
                        className="mt-0.5 shrink-0"
                      />
                      <div className={cn("min-w-0 flex-1", !isEnabled && "opacity-50")}>
                        <div className="flex items-center gap-2">
                          <span className="text-foreground text-sm font-medium">{name}</span>
                          {cached?.result.success && !isEditing && isEnabled && (
                            <span
                              className="rounded bg-green-500/10 px-1.5 py-0.5 text-xs text-green-500"
                              title={`Tested ${formatRelativeTime(cached.testedAt)}`}
                            >
                              {cached.result.tools.length} tools
                            </span>
                          )}
                          {!isEnabled && <span className="text-muted text-xs">disabled</span>}
                        </div>
                        {isEditing ? (
                          <div className="mt-2 space-y-2">
                            <p className="text-muted text-xs">transport: {editing.transport}</p>
                            <input
                              type="text"
                              value={editing.value}
                              onChange={(e) =>
                                setEditing({
                                  ...editing,
                                  value: e.target.value,
                                })
                              }
                              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-xs focus:outline-none"
                              autoFocus
                              spellCheck={false}
                              onKeyDown={createEditKeyHandler({
                                onSave: () => void handleSaveEdit(),
                                onCancel: handleCancelEdit,
                              })}
                            />
                            {editing.transport !== "stdio" && (
                              <div>
                                <div className="text-muted mb-1 text-[11px]">
                                  HTTP headers (optional)
                                </div>
                                <MCPHeadersEditor
                                  rows={editing.headersRows}
                                  onChange={(rows) =>
                                    setEditing({
                                      ...editing,
                                      headersRows: rows,
                                    })
                                  }
                                  secretKeys={projectSecretKeys}
                                  disabled={savingEdit}
                                />
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-muted mt-0.5 font-mono text-xs break-all">
                            {serverDisplayValue(entry)}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {isEditing ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => void handleSaveEdit()}
                              disabled={
                                savingEdit ||
                                !editing.value.trim() ||
                                editHeadersValidation.errors.length > 0
                              }
                              className="h-7 w-7 text-green-500 hover:text-green-400"
                              title="Save (Enter)"
                            >
                              {savingEdit ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Check className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={handleCancelEdit}
                              disabled={savingEdit}
                              className="text-muted hover:text-foreground h-7 w-7"
                              title="Cancel (Esc)"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => void handleTest(name)}
                              disabled={isTesting}
                              className="text-muted hover:text-accent h-7 w-7"
                              title="Test connection"
                            >
                              {isTesting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Play className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleStartEdit(name, entry)}
                              className="text-muted hover:text-accent h-7 w-7"
                              title="Edit server"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => void handleRemove(name)}
                              disabled={loading}
                              className="text-muted hover:text-error h-7 w-7"
                              title="Remove server"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    {cached && !cached.result.success && !isEditing && (
                      <div className="border-border-medium text-destructive border-t px-3 py-2 text-xs">
                        <div className="flex items-start gap-1.5">
                          <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>{cached.result.error}</span>
                        </div>
                      </div>
                    )}
                    {cached?.result.success && cached.result.tools.length > 0 && !isEditing && (
                      <div className="border-border-medium border-t px-3 py-2">
                        <ToolAllowlistSection
                          serverName={name}
                          availableTools={cached.result.tools}
                          currentAllowlist={entry.toolAllowlist}
                          testedAt={cached.testedAt}
                          onSaveAllowlist={(toolAllowlist) => setToolAllowlist(name, toolAllowlist)}
                        />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Add server form */}
          <details className="group mt-3">
            <summary className="text-accent hover:text-accent/80 flex cursor-pointer list-none items-center gap-1 text-sm font-medium">
              <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
              Add server
            </summary>
            <div className="border-border-medium bg-background-secondary mt-2 space-y-3 rounded-md border p-3">
              <div>
                <label
                  htmlFor={`${idPrefix}-server-name`}
                  className="text-muted mb-1 block text-xs"
                >
                  Name
                </label>
                <input
                  id={`${idPrefix}-server-name`}
                  type="text"
                  placeholder="e.g., memory"
                  value={newServer.name}
                  onChange={(e) => setNewServer((prev) => ({ ...prev, name: e.target.value }))}
                  className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 text-sm focus:outline-none"
                />
              </div>

              <div>
                <label className="text-muted mb-1 block text-xs">Transport</label>
                <Select
                  value={newServer.transport}
                  onValueChange={(value) =>
                    setNewServer((prev) => ({
                      ...prev,
                      transport: value as MCPServerTransport,
                      value: "",
                      headersRows: [],
                    }))
                  }
                >
                  <SelectTrigger className="border-border-medium bg-modal-bg h-8 w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {mcpAllowUserDefined?.stdio !== false && (
                      <SelectItem value="stdio">Stdio</SelectItem>
                    )}
                    {mcpAllowUserDefined?.remote !== false && (
                      <>
                        <SelectItem value="http">HTTP (Streamable)</SelectItem>
                        <SelectItem value="sse">SSE (Legacy)</SelectItem>
                        <SelectItem value="auto">Auto (HTTP → SSE)</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label
                  htmlFor={`${idPrefix}-server-value`}
                  className="text-muted mb-1 block text-xs"
                >
                  {newServer.transport === "stdio" ? "Command" : "URL"}
                </label>
                <input
                  id={`${idPrefix}-server-value`}
                  type="text"
                  placeholder={
                    newServer.transport === "stdio"
                      ? "e.g., npx -y @modelcontextprotocol/server-memory"
                      : "e.g., http://localhost:3333/mcp"
                  }
                  value={newServer.value}
                  onChange={(e) => setNewServer((prev) => ({ ...prev, value: e.target.value }))}
                  spellCheck={false}
                  className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
                />
              </div>

              {newServer.transport !== "stdio" && (
                <div>
                  <label className="text-muted mb-1 block text-xs">HTTP headers (optional)</label>
                  <MCPHeadersEditor
                    rows={newServer.headersRows}
                    onChange={(rows) =>
                      setNewServer((prev) => ({
                        ...prev,
                        headersRows: rows,
                      }))
                    }
                    secretKeys={projectSecretKeys}
                    disabled={addingServer || testingNew}
                  />
                </div>
              )}

              {/* Test result */}
              {newTestResult && (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-md px-3 py-2 text-sm",
                    newTestResult.result.success
                      ? "bg-green-500/10 text-green-500"
                      : "bg-destructive/10 text-destructive"
                  )}
                >
                  {newTestResult.result.success ? (
                    <>
                      <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <span className="font-medium">
                          Connected — {newTestResult.result.tools.length} tools
                        </span>
                        {newTestResult.result.tools.length > 0 && (
                          <p className="mt-0.5 text-xs opacity-80">
                            {newTestResult.result.tools.join(", ")}
                          </p>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{newTestResult.result.error}</span>
                    </>
                  )}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTestNewServer()}
                  disabled={!canTest || testingNew}
                >
                  {testingNew ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  {testingNew ? "Testing…" : "Test"}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleAddServer()}
                  disabled={!canAdd || addingServer}
                >
                  {addingServer ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  {addingServer ? "Adding…" : "Add"}
                </Button>
              </div>
            </div>
          </details>
        </>
      )}
    </div>
  );
};

export const ProjectSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const policyState = usePolicy();

  const mcpAllowUserDefined: McpAllowUserDefined =
    policyState.status.state === "enforced" ? policyState.policy?.mcp.allowUserDefined : undefined;

  const mcpDisabledByPolicy = Boolean(
    mcpAllowUserDefined?.stdio === false && mcpAllowUserDefined.remote === false
  );

  const { projectsTargetProjectPath, clearProjectsTargetProjectPath } = useSettings();
  const { projects, getSecrets } = useProjectContext();

  const projectList = Array.from(projects.keys());

  const [selectedProject, setSelectedProject] = useState<string>("");
  const [projectSecretKeys, setProjectSecretKeys] = useState<string[]>([]);

  const {
    cache: testCache,
    setResult: cacheTestResult,
    clearResult: clearTestResult,
  } = useMCPTestCache(selectedProject);

  // Default project selection (or deep-link into a target project from elsewhere)
  useEffect(() => {
    if (projectList.length === 0) {
      setSelectedProject("");
      return;
    }

    if (projectsTargetProjectPath) {
      const target = projectsTargetProjectPath;
      clearProjectsTargetProjectPath();

      if (projectList.includes(target)) {
        setSelectedProject(target);
        return;
      }
    }

    if (!selectedProject || !projectList.includes(selectedProject)) {
      setSelectedProject(projectList[0]);
    }
  }, [projectList, selectedProject, projectsTargetProjectPath, clearProjectsTargetProjectPath]);

  // Fetch secret keys for header validation in the MCP UI.
  useEffect(() => {
    if (!selectedProject) {
      setProjectSecretKeys([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const secrets = await getSecrets(selectedProject);
        if (cancelled) return;
        setProjectSecretKeys(secrets.map((s) => s.key));
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load project secrets:", err);
        setProjectSecretKeys([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getSecrets, selectedProject]);

  const projectName = (path: string) => path.split(/[\\/]/).pop() ?? path;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-muted mb-4 text-xs">
          Configure MCP servers globally (stored in{" "}
          <code className="text-accent">~/.mux/mcp.jsonc</code>) and per-project (stored in{" "}
          <code className="text-accent">.mux/mcp.jsonc</code>). Project servers override global
          servers on name collisions.
        </p>

        {projectList.length === 0 ? (
          <div className="text-muted text-xs">
            No projects configured yet. Global MCP servers can still be configured below.
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-foreground text-sm">Project</div>
              <div className="text-muted text-xs">Select a project to configure</div>
            </div>
            <Select value={selectedProject} onValueChange={setSelectedProject}>
              <SelectTrigger className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projectList.map((path) => (
                  <SelectItem key={path} value={path}>
                    {projectName(path)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <McpServersEditor
        title="Global MCP Servers"
        description={
          <p className="text-muted text-xs">
            Applies to all projects. To test a server (and to validate secret header references),
            pick a project above.
          </p>
        }
        disabledByPolicy={mcpDisabledByPolicy}
        mcpAllowUserDefined={mcpAllowUserDefined}
        projectSecretKeys={projectSecretKeys}
        testCachePrefix="global"
        testCache={testCache}
        cacheTestResult={cacheTestResult}
        clearTestResult={clearTestResult}
        loadDiagnostics={() =>
          api
            ? api.global.mcp.getDiagnostics()
            : Promise.resolve({
                filePath: "",
                parseErrors: [],
                validationErrors: [],
              })
        }
        loadServers={() => (api ? api.global.mcp.list() : Promise.resolve({}))}
        addOrUpdateServer={({ name, transport, value, headers }) => {
          if (!api) {
            return Promise.resolve({ success: false, error: "API unavailable" });
          }

          return api.global.mcp.add({
            name,
            ...(transport === "stdio"
              ? { transport: "stdio", command: value }
              : { transport, url: value, headers }),
          });
        }}
        removeServer={(name) => {
          if (!api) {
            return Promise.resolve({ success: false, error: "API unavailable" });
          }
          return api.global.mcp.remove({ name });
        }}
        setEnabled={(name, enabled) => {
          if (!api) {
            return Promise.resolve({ success: false, error: "API unavailable" });
          }
          return api.global.mcp.setEnabled({ name, enabled });
        }}
        testServerByName={(name) => {
          if (!api) {
            return Promise.resolve({ success: false, error: "API unavailable" });
          }
          if (!selectedProject) {
            return Promise.resolve({
              success: false,
              error: "Select a project first (needed to resolve secret headers)",
            });
          }
          return api.global.mcp.test({ projectPath: selectedProject, name });
        }}
        testServerAdhoc={({ transport, value, headers }) => {
          if (!api) {
            return Promise.resolve({ success: false, error: "API unavailable" });
          }
          if (!selectedProject) {
            return Promise.resolve({
              success: false,
              error: "Select a project first (needed to resolve secret headers)",
            });
          }

          return api.global.mcp.test({
            projectPath: selectedProject,
            ...(transport === "stdio" ? { command: value } : { transport, url: value, headers }),
          });
        }}
        setToolAllowlist={(name, toolAllowlist) => {
          if (!api) {
            return Promise.resolve({ success: false, error: "API unavailable" });
          }
          return api.global.mcp.setToolAllowlist({ name, toolAllowlist });
        }}
      />

      <div className="border-border-medium border-t pt-6">
        <McpServersEditor
          title="Project MCP Servers"
          description={
            <p className="text-muted text-xs">
              Stored in <code className="text-accent">.mux/mcp.jsonc</code> in your project.
            </p>
          }
          disabledByPolicy={mcpDisabledByPolicy}
          mcpAllowUserDefined={mcpAllowUserDefined}
          projectSecretKeys={projectSecretKeys}
          testCache={testCache}
          cacheTestResult={cacheTestResult}
          clearTestResult={clearTestResult}
          loadDiagnostics={() => {
            if (!api) {
              return Promise.resolve({ filePath: "", parseErrors: [], validationErrors: [] });
            }
            if (!selectedProject) {
              return Promise.resolve({ filePath: "", parseErrors: [], validationErrors: [] });
            }

            return api.projects.mcp.getDiagnostics({ projectPath: selectedProject });
          }}
          loadServers={() => {
            if (!api) {
              return Promise.resolve({});
            }
            if (!selectedProject) {
              return Promise.resolve({});
            }
            return api.projects.mcp.list({ projectPath: selectedProject });
          }}
          addOrUpdateServer={({ name, transport, value, headers }) => {
            if (!api) {
              return Promise.resolve({ success: false, error: "API unavailable" });
            }
            if (!selectedProject) {
              return Promise.resolve({ success: false, error: "Select a project first" });
            }

            return api.projects.mcp.add({
              projectPath: selectedProject,
              name,
              ...(transport === "stdio"
                ? { transport: "stdio", command: value }
                : { transport, url: value, headers }),
            });
          }}
          removeServer={(name) => {
            if (!api) {
              return Promise.resolve({ success: false, error: "API unavailable" });
            }
            if (!selectedProject) {
              return Promise.resolve({ success: false, error: "Select a project first" });
            }

            return api.projects.mcp.remove({ projectPath: selectedProject, name });
          }}
          setEnabled={(name, enabled) => {
            if (!api) {
              return Promise.resolve({ success: false, error: "API unavailable" });
            }
            if (!selectedProject) {
              return Promise.resolve({ success: false, error: "Select a project first" });
            }

            return api.projects.mcp.setEnabled({ projectPath: selectedProject, name, enabled });
          }}
          testServerByName={(name) => {
            if (!api) {
              return Promise.resolve({ success: false, error: "API unavailable" });
            }
            if (!selectedProject) {
              return Promise.resolve({ success: false, error: "Select a project first" });
            }

            return api.projects.mcp.test({ projectPath: selectedProject, name });
          }}
          testServerAdhoc={({ transport, value, headers }) => {
            if (!api) {
              return Promise.resolve({ success: false, error: "API unavailable" });
            }
            if (!selectedProject) {
              return Promise.resolve({ success: false, error: "Select a project first" });
            }

            return api.projects.mcp.test({
              projectPath: selectedProject,
              ...(transport === "stdio" ? { command: value } : { transport, url: value, headers }),
            });
          }}
          setToolAllowlist={(name, toolAllowlist) => {
            if (!api) {
              return Promise.resolve({ success: false, error: "API unavailable" });
            }
            if (!selectedProject) {
              return Promise.resolve({ success: false, error: "Select a project first" });
            }

            return api.projects.mcp.setToolAllowlist({
              projectPath: selectedProject,
              name,
              toolAllowlist,
            });
          }}
        />
      </div>
    </div>
  );
};
