import React, { useCallback, useEffect, useState } from "react";
import { CheckCircle, ChevronRight, Loader2, Play, Plus, XCircle } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { MCPHeadersEditor } from "@/browser/components/MCPHeadersEditor/MCPHeadersEditor";
import { MCPOAuthRequiredCallout } from "@/browser/components/MCPOAuth/MCPOAuth";
import { useAPI } from "@/browser/contexts/API";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import { useMCPTestCache } from "@/browser/hooks/useMCPTestCache";
import { mcpHeaderRowsToRecord, type MCPHeaderRow } from "@/browser/utils/mcpHeaders";
import { cn } from "@/common/lib/utils";
import type { CachedMCPTestResult, MCPServerInfo, MCPServerTransport } from "@/common/types/mcp";

interface EditableServer {
  name: string;
  transport: MCPServerTransport;
  /** command (stdio) or url (http/sse/auto) */
  value: string;
  /** Headers (http/sse/auto only) */
  headersRows: MCPHeaderRow[];
}

interface MCPAddServerFormProps {
  /** Existing global servers (used by the OAuth callout to detect collisions). */
  existingServers: Record<string, MCPServerInfo>;
  /** Called after a successful add so the parent can refresh its list. */
  onAdded?: (name: string) => void | Promise<void>;
  /**
   * When true, render the form inline (no expandable `<details>` wrapper).
   * Defaults to false (Settings panel uses the expandable summary).
   */
  alwaysExpanded?: boolean;
  /** Optional className applied to the outer wrapper. */
  className?: string;
}

/**
 * Inline "Add MCP server" form. Writes to global config via `api.mcp.add`,
 * with optional pre-add Test and an OAuth callout for remote servers that
 * advertise a `WWW-Authenticate: Bearer` challenge.
 *
 * Extracted verbatim from `MCPSettingsSection`; shared between the global
 * Settings panel and the per-chat "Manage MCP servers" modal.
 */
export const MCPAddServerForm: React.FC<MCPAddServerFormProps> = ({
  existingServers,
  onAdded,
  alwaysExpanded = false,
  className,
}) => {
  const { api } = useAPI();
  const policyState = usePolicy();
  const mcpAllowUserDefined =
    policyState.status.state === "enforced" ? policyState.policy?.mcp.allowUserDefined : undefined;

  const { setResult: cacheTestResult } = useMCPTestCache("__global__");
  const [globalSecretKeys, setGlobalSecretKeys] = useState<string[]>([]);

  const [newServer, setNewServer] = useState<EditableServer>({
    name: "",
    transport: "stdio",
    value: "",
    headersRows: [],
  });
  const [addingServer, setAddingServer] = useState(false);
  const [testingNew, setTestingNew] = useState(false);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [newTestResult, setNewTestResult] = useState<CachedMCPTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setMcpOauthRefreshNonce] = useState(0);

  // Load global secrets (used for {secret:"KEY"} header values).
  useEffect(() => {
    if (!api) {
      setGlobalSecretKeys([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const secrets = await api.secrets.get({});
        if (cancelled) return;
        setGlobalSecretKeys(secrets.map((s) => s.key));
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load global secrets:", err);
        setGlobalSecretKeys([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api]);

  // Ensure the "Add server" transport select always points to a policy-allowed value.
  useEffect(() => {
    if (!mcpAllowUserDefined) {
      return;
    }

    const isAllowed = (transport: MCPServerTransport): boolean => {
      if (transport === "stdio") {
        return mcpAllowUserDefined.stdio;
      }

      return mcpAllowUserDefined.remote;
    };

    setNewServer((prev) => {
      if (isAllowed(prev.transport)) {
        return prev;
      }

      const fallback: MCPServerTransport | null = mcpAllowUserDefined.stdio
        ? "stdio"
        : mcpAllowUserDefined.remote
          ? "http"
          : null;

      if (!fallback) {
        return prev;
      }

      return { ...prev, transport: fallback, value: "", headersRows: [] };
    });
  }, [mcpAllowUserDefined]);

  // Clear new-server test result when transport/value/headers change
  useEffect(() => {
    setNewTestResult(null);
  }, [newServer.transport, newServer.value, newServer.headersRows]);

  const handleTestNewServer = useCallback(async () => {
    if (!api || !newServer.value.trim()) return;
    setTestingNew(true);
    setNewTestResult(null);

    try {
      const { headers, validation } =
        newServer.transport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(newServer.headersRows, {
              knownSecretKeys: new Set(globalSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

      const pendingName = newServer.name.trim();

      const result = await api.mcp.test({
        ...(newServer.transport === "stdio"
          ? { command: newServer.value.trim() }
          : {
              ...(pendingName ? { name: pendingName } : {}),
              transport: newServer.transport,
              url: newServer.value.trim(),
              headers,
            }),
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
  }, [
    api,
    newServer.name,
    newServer.transport,
    newServer.value,
    newServer.headersRows,
    globalSecretKeys,
  ]);

  const handleAddServer = useCallback(async () => {
    if (!api || !newServer.name.trim() || !newServer.value.trim()) return;

    const serverName = newServer.name.trim();
    const serverTransport = newServer.transport;
    const serverValue = newServer.value.trim();
    const serverHeadersRows = newServer.headersRows;
    const existingTestResult = newTestResult;

    setAddingServer(true);
    setError(null);

    try {
      const { headers, validation } =
        serverTransport === "stdio"
          ? { headers: undefined, validation: { errors: [], warnings: [] } }
          : mcpHeaderRowsToRecord(serverHeadersRows, {
              knownSecretKeys: new Set(globalSecretKeys),
            });

      if (validation.errors.length > 0) {
        throw new Error(validation.errors[0]);
      }

      const result = await api.mcp.add({
        name: serverName,
        ...(serverTransport === "stdio"
          ? { transport: "stdio", command: serverValue }
          : {
              transport: serverTransport,
              url: serverValue,
              headers,
            }),
      });

      if (!result.success) {
        setError(result.error ?? "Failed to add MCP server");
        return;
      }

      setNewServer({ name: "", transport: "stdio", value: "", headersRows: [] });
      setNewTestResult(null);
      await onAdded?.(serverName);

      // For stdio, avoid running arbitrary user-provided commands automatically.
      if (serverTransport === "stdio") {
        if (existingTestResult?.result.success) {
          cacheTestResult(serverName, existingTestResult.result);
        }
        return;
      }

      // For remote servers, always run a test immediately after adding so OAuth-required servers can
      // surface an OAuth callout without requiring a manual Test click.
      setTestingServer(serverName);
      try {
        const testResult = await api.mcp.test({
          name: serverName,
        });
        cacheTestResult(serverName, testResult);
      } catch (err) {
        cacheTestResult(serverName, {
          success: false,
          error: err instanceof Error ? err.message : "Test failed",
        });
      } finally {
        setTestingServer(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add MCP server");
    } finally {
      setAddingServer(false);
    }
  }, [api, newServer, newTestResult, onAdded, cacheTestResult, globalSecretKeys]);

  const newHeadersValidation =
    newServer.transport === "stdio"
      ? { errors: [], warnings: [] }
      : mcpHeaderRowsToRecord(newServer.headersRows, {
          knownSecretKeys: new Set(globalSecretKeys),
        }).validation;

  const canAdd =
    newServer.name.trim().length > 0 &&
    newServer.value.trim().length > 0 &&
    (newServer.transport === "stdio" || newHeadersValidation.errors.length === 0);

  const canTest =
    newServer.value.trim().length > 0 &&
    (newServer.transport === "stdio" || newHeadersValidation.errors.length === 0);

  // Suppress unused-var lint warning for testingServer (it is set so callers can disable
  // dependent UI later; right now we just track it).
  void testingServer;

  const body = (
    <div className="border-border-medium bg-background-secondary mt-2 space-y-3 rounded-md border p-3">
      <div>
        <label htmlFor="server-name" className="text-muted mb-1 block text-xs">
          Name
        </label>
        <input
          id="server-name"
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
            {mcpAllowUserDefined?.stdio !== false && <SelectItem value="stdio">Stdio</SelectItem>}
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
        <label htmlFor="server-value" className="text-muted mb-1 block text-xs">
          {newServer.transport === "stdio" ? "Command" : "URL"}
        </label>
        <input
          id="server-value"
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
            secretKeys={globalSecretKeys}
            disabled={addingServer || testingNew}
          />
        </div>
      )}

      {/* Error surfacing for add failures (validation, oRPC errors, etc.) */}
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-xs">
          {error}
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

      {newTestResult && !newTestResult.result.success && newTestResult.result.oauthChallenge && (
        <div className="mt-2">
          <MCPOAuthRequiredCallout
            serverName={newServer.name.trim()}
            pendingServer={(() => {
              const pendingName = newServer.name.trim();
              if (!pendingName) {
                return undefined;
              }

              // If the server already exists in config, prefer that config for OAuth.
              const existing = existingServers[pendingName];
              if (existing) {
                return undefined;
              }

              if (newServer.transport === "stdio") {
                return undefined;
              }

              const url = newServer.value.trim();
              if (!url) {
                return undefined;
              }

              return { transport: newServer.transport, url };
            })()}
            disabledReason={(() => {
              const pendingName = newServer.name.trim();
              if (!pendingName) {
                return "Enter a server name to enable OAuth login.";
              }

              const existing = existingServers[pendingName];

              const transport = existing?.transport ?? newServer.transport;
              if (transport === "stdio") {
                return "OAuth login is only supported for remote (http/sse) MCP servers.";
              }

              return undefined;
            })()}
            onLoginSuccess={async () => {
              setMcpOauthRefreshNonce((prev) => prev + 1);
              await handleTestNewServer();
            }}
          />
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
        <Button size="sm" onClick={() => void handleAddServer()} disabled={!canAdd || addingServer}>
          {addingServer ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {addingServer ? "Adding…" : "Add"}
        </Button>
      </div>
    </div>
  );

  if (alwaysExpanded) {
    return <div className={className}>{body}</div>;
  }

  return (
    <details className={cn("group mt-3", className)}>
      <summary className="text-accent hover:text-accent/80 flex cursor-pointer list-none items-center gap-1 text-sm font-medium">
        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
        Add server
      </summary>
      {body}
    </details>
  );
};
