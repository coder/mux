import React from "react";
import { Loader2, Plus, Server } from "lucide-react";
import type { MCPServerInfo } from "@/common/types/mcp";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { Button } from "@/browser/components/ui/button";

interface ProjectMCPOverviewProps {
  projectPath: string;
}

export const ProjectMCPOverview: React.FC<ProjectMCPOverviewProps> = (props) => {
  const projectPath = props.projectPath;
  const { api } = useAPI();
  const settings = useSettings();

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [servers, setServers] = React.useState<Record<string, MCPServerInfo>>({});

  React.useEffect(() => {
    if (!api || settings.isOpen) return;
    let cancelled = false;

    setLoading(true);
    api.projects.mcp
      .list({ projectPath })
      .then((result) => {
        if (cancelled) return;
        setServers(result ?? {});
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

  const enabledServerNames = Object.entries(servers)
    .filter(([, info]) => !info.disabled)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  const shownServerNames = enabledServerNames.slice(0, 3);
  const remainingCount = enabledServerNames.length - shownServerNames.length;

  return (
    <div className="border-border rounded-lg border">
      <div className="flex items-start gap-3 px-4 py-3">
        <Server className="text-muted mt-0.5 h-4 w-4" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground font-medium">
              MCP Servers ({enabledServerNames.length} enabled)
            </span>
            {loading && <Loader2 className="text-muted h-4 w-4 animate-spin" />}
          </div>

          {error ? (
            <div className="text-error mt-1 text-xs">{error}</div>
          ) : enabledServerNames.length === 0 ? (
            <div className="text-muted mt-1 text-xs">No MCP servers enabled for this project.</div>
          ) : (
            <div className="text-muted mt-1 text-xs">
              {shownServerNames.join(", ")}
              {remainingCount > 0 && <span className="text-muted/60"> +{remainingCount} more</span>}
            </div>
          )}
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => settings.openProjectSettings(projectPath)}
        >
          <Plus />
          Add MCP server
        </Button>
      </div>
    </div>
  );
};
