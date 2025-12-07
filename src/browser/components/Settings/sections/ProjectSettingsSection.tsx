import React, { useCallback, useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Trash2 } from "lucide-react";

export const ProjectSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const { selectedWorkspace } = useWorkspaceContext();
  const projectPath = selectedWorkspace?.projectPath;

  const [servers, setServers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api || !projectPath) return;
    setLoading(true);
    try {
      const result = await api.projects.mcp.list({ projectPath });
      setServers(result ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, [api, projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRemove = useCallback(
    async (name: string) => {
      if (!api || !projectPath) return;
      setLoading(true);
      try {
        const result = await api.projects.mcp.remove({ projectPath, name });
        if (!result.success) {
          setError(result.error ?? "Failed to remove MCP server");
        } else {
          await refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove MCP server");
      } finally {
        setLoading(false);
      }
    },
    [api, projectPath, refresh]
  );

  if (!projectPath) {
    return (
      <p className="text-muted-foreground text-sm">
        Select a workspace to manage project settings.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">MCP Servers</h3>
        <p className="text-muted-foreground text-sm">
          Servers are stored in <code>.mux/mcp.jsonc</code> in this project. Use{" "}
          <code>/mcp add</code> to add new entries.
        </p>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {loading && <p className="text-muted-foreground text-sm">Loading…</p>}

      {!loading && Object.keys(servers).length === 0 && (
        <p className="text-muted-foreground text-sm">No MCP servers configured.</p>
      )}

      <ul className="space-y-2">
        {Object.entries(servers).map(([name, command]) => (
          <li
            key={name}
            className="border-border-medium/60 bg-secondary/30 flex items-start justify-between rounded-md border px-3 py-2"
          >
            <div className="space-y-1">
              <div className="font-medium">{name}</div>
              <div className="text-muted-foreground text-xs break-all">{command}</div>
            </div>
            <button
              type="button"
              onClick={() => void handleRemove(name)}
              className="text-muted-foreground hover:text-destructive flex items-center gap-1 text-xs"
              aria-label={`Remove MCP server ${name}`}
              disabled={loading}
            >
              <Trash2 className="h-4 w-4" /> Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
