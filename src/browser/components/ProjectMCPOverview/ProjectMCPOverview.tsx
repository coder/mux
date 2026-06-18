import React from "react";
import { Loader2, Server, SlidersHorizontal } from "lucide-react";
import type { MCPServerInfo, WorkspaceMCPOverrides } from "@/common/types/mcp";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Button } from "@/browser/components/Button/Button";
import { WorkspaceMCPModal } from "@/browser/components/WorkspaceMCPModal/WorkspaceMCPModal";
import { getMCPServersKey } from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { effectiveEnabledServerNames, hasAnyOverride } from "@/common/utils/workspaceMcpEffective";

interface ProjectMCPOverviewProps {
  projectPath: string;
  /**
   * Per-workspace MCP overrides currently staged on the creation page. The
   * overview reflects the *effective* set (project servers + staged overrides)
   * so the count matches what the workspace will actually see.
   */
  stagedOverrides?: WorkspaceMCPOverrides;
  /** Called when the user saves changes from the "Manage MCP servers" modal. */
  onStagedOverridesChange?: (next: WorkspaceMCPOverrides) => void;
}

export const ProjectMCPOverview: React.FC<ProjectMCPOverviewProps> = (props) => {
  const { projectPath, stagedOverrides, onStagedOverridesChange } = props;
  const { api } = useAPI();
  const settings = useSettings();

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [manageOpen, setManageOpen] = React.useState(false);
  // Initialize from localStorage cache to avoid flash
  const [servers, setServers] = React.useState<Record<string, MCPServerInfo>>(() =>
    readPersistedState<Record<string, MCPServerInfo>>(getMCPServersKey(projectPath), {})
  );

  React.useEffect(() => {
    if (!api || settings.isOpen) return;
    let cancelled = false;

    setLoading(true);
    api.mcp
      .list({ projectPath })
      .then((result) => {
        if (cancelled) return;
        const newServers = result ?? {};
        setServers(newServers);
        // Cache for next load
        updatePersistedState(getMCPServersKey(projectPath), newServers);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setServers({});
        setError(err instanceof Error ? err.message : "Failed to load MCP servers");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, projectPath, settings.isOpen]);

  // Refetch servers whenever the manage modal closes (it may have added new ones).
  React.useEffect(() => {
    if (!api || manageOpen) return;
    let cancelled = false;
    api.mcp
      .list({ projectPath })
      .then((result) => {
        if (cancelled) return;
        const newServers = result ?? {};
        setServers(newServers);
        updatePersistedState(getMCPServersKey(projectPath), newServers);
      })
      .catch(() => {
        // Errors are surfaced by the main load effect; this is just opportunistic.
      });
    return () => {
      cancelled = true;
    };
  }, [api, projectPath, manageOpen]);

  // Compute the effective enabled set: project defaults overridden by staged workspace overrides.
  const enabledServerNames = React.useMemo(
    () => effectiveEnabledServerNames(servers, stagedOverrides),
    [servers, stagedOverrides]
  );

  const shownServerNames = enabledServerNames.slice(0, 3);
  const remainingCount = enabledServerNames.length - shownServerNames.length;
  const isModified = hasAnyOverride(stagedOverrides);

  return (
    <>
      <div className="border-border rounded-lg border">
        <div className="flex items-start gap-3 px-4 py-3">
          <Server className="text-muted mt-0.5 h-4 w-4" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-foreground font-medium">
                MCP Servers ({enabledServerNames.length} enabled)
              </span>
              {isModified && (
                <span className="text-muted/80 text-xs">(modified for this chat)</span>
              )}
              {loading && <Loader2 className="text-muted h-4 w-4 animate-spin" />}
            </div>

            {error ? (
              <div className="text-error mt-1 text-xs">{error}</div>
            ) : enabledServerNames.length === 0 ? (
              <div className="text-muted mt-1 text-xs">
                No MCP servers enabled for this project.
              </div>
            ) : (
              <div className="text-muted mt-1 text-xs">
                {shownServerNames.join(", ")}
                {remainingCount > 0 && (
                  <span className="text-muted/60"> +{remainingCount} more</span>
                )}
              </div>
            )}
          </div>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => setManageOpen(true)}
          >
            <SlidersHorizontal />
            Manage MCP servers
          </Button>
        </div>
      </div>

      <WorkspaceMCPModal
        mode="draft"
        projectPath={projectPath}
        open={manageOpen}
        onOpenChange={setManageOpen}
        initialOverrides={stagedOverrides ?? {}}
        onSave={(next) => onStagedOverridesChange?.(next)}
      />
    </>
  );
};
