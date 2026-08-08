import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  CircleAlert,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { cn } from "@/common/lib/utils";
import type {
  AgentPluginInstallPreview,
  AgentPluginListItem,
  AgentPluginUpdateCheck,
} from "@/common/orpc/schemas/agentPlugins";
import { getErrorMessage } from "@/common/utils/errors";
import {
  consumePendingPluginsSectionIntent,
  subscribePluginsSectionIntents,
  type PluginsSectionIntent,
} from "./pluginsSectionIntents";

/**
 * Settings → Plugins (agent-plugins experiment; global scope only).
 *
 * Managed installs come from the `plugins` registry in ~/.mux/config.json;
 * unmanaged plugin directories found by discovery are listed read-only.
 * Update checks run on section open and on the explicit button only — no
 * background timers, and updates never auto-apply.
 */

/** Compact source display, e.g. "github.com/foo/grill @ main". */
function formatSource(item: AgentPluginListItem): string | null {
  if (!item.source) {
    return null;
  }
  const url = item.source.url
    .replace(/^https:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
  const ref = item.source.refType === "commit" ? item.source.ref.slice(0, 12) : item.source.ref;
  return `${url} @ ${ref}`;
}

const Badge: React.FC<{
  tone: "muted" | "accent" | "warning" | "error";
  children: React.ReactNode;
}> = (props) => (
  <span
    className={cn(
      "rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      props.tone === "muted" && "bg-foreground/10 text-muted",
      props.tone === "accent" && "bg-accent/15 text-accent",
      props.tone === "warning" && "bg-yellow-500/15 text-yellow-500",
      props.tone === "error" && "bg-destructive/15 text-destructive"
    )}
  >
    {props.children}
  </span>
);

/** Two-phase add flow: source input → consent preview → install. */
const AddPluginPanel: React.FC<{
  onInstalled: () => void;
  onClose: () => void;
}> = (props) => {
  const { api } = useAPI();
  const [input, setInput] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AgentPluginInstallPreview | null>(null);

  const handlePreview = useCallback(async () => {
    if (!api || input.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.agentPlugins.preview({
        input: input.trim(),
        ref: ref.trim().length > 0 ? ref.trim() : null,
      });
      if (result.success) {
        setPreview(result.data);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [api, input, ref, busy]);

  const handleInstall = useCallback(async () => {
    if (!api || !preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.agentPlugins.install({
        source: preview.source,
        expectedSha: preview.lockedSha,
      });
      if (result.success) {
        props.onInstalled();
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [api, preview, busy, props]);

  return (
    <div className="border-border-medium bg-background-secondary space-y-3 rounded-md border p-3">
      {preview === null ? (
        <>
          <div>
            <label htmlFor="plugin-source" className="text-muted mb-1 block text-xs">
              Git URL or owner/repo
            </label>
            <input
              id="plugin-source"
              type="text"
              autoFocus
              placeholder="e.g., owner/repo, owner/repo@v1.2.0, or https://github.com/owner/repo.git"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handlePreview();
              }}
              spellCheck={false}
              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="plugin-ref" className="text-muted mb-1 block text-xs">
              Branch, tag, or commit SHA (optional — defaults to the default branch)
            </label>
            <input
              id="plugin-ref"
              type="text"
              placeholder="e.g., main, v1.2.0, or a full 40-character SHA"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handlePreview();
              }}
              spellCheck={false}
              className="bg-modal-bg border-border-medium focus:border-accent w-full rounded border px-2 py-1.5 font-mono text-sm focus:outline-none"
            />
          </div>
          {error && (
            <div className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handlePreview()}
              disabled={busy || input.trim().length === 0}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {busy ? "Fetching…" : "Preview"}
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          {/* Consent preview: everything the plugin will contribute, before anything is written. */}
          <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-foreground text-sm font-medium">{preview.manifest.name}</span>
              {preview.manifest.version && (
                <span className="text-muted text-xs">v{preview.manifest.version}</span>
              )}
              <Badge tone="muted">
                {preview.source.refType} · {preview.lockedSha.slice(0, 12)}
              </Badge>
            </div>
            {preview.manifest.description && (
              <p className="text-muted text-xs">{preview.manifest.description}</p>
            )}
            <p className="text-muted text-[11px]">
              {preview.source.url} @ {preview.source.ref} →{" "}
              <code className="text-accent">{preview.targetPath}</code>
              {preview.manifest.authorName ? ` · by ${preview.manifest.authorName}` : ""}
              {preview.manifest.license ? ` · ${preview.manifest.license}` : ""}
            </p>
          </div>

          {preview.warnings.length > 0 && (
            <div className="space-y-1 rounded-md bg-yellow-500/10 px-3 py-2">
              {preview.warnings.map((warning) => (
                <div key={warning} className="flex items-start gap-2 text-xs text-yellow-500">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">{warning}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <h4 className="text-foreground mb-1 text-xs font-medium">
              Skills ({preview.skills.length})
            </h4>
            {preview.skills.length === 0 ? (
              <p className="text-muted text-xs">None</p>
            ) : (
              <ul className="space-y-0.5">
                {preview.skills.map((skill) => (
                  <li key={skill.name} className="text-xs">
                    <span className="text-foreground font-mono">{skill.name}</span>
                    {skill.description && (
                      <span className="text-muted"> — {skill.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="text-foreground mb-1 text-xs font-medium">
              MCP servers ({preview.mcpServers.length})
            </h4>
            {preview.mcpServers.length === 0 ? (
              <p className="text-muted text-xs">None</p>
            ) : (
              <ul className="space-y-1">
                {preview.mcpServers.map((server) => (
                  <li key={server.serverName} className="text-xs">
                    <span className="text-foreground font-mono">{server.serverName}</span>{" "}
                    <Badge tone="muted">{server.transport}</Badge>
                    <pre className="bg-modal-bg border-border-medium mt-0.5 overflow-x-auto rounded border px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap">
                      {server.summary}
                    </pre>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted mt-1 text-[11px]">
              MCP servers stay disabled until you enable them per workspace.
            </p>
          </div>

          {error && (
            <div className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-sm">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
              disabled={busy}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <Button size="sm" onClick={() => void handleInstall()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {busy ? "Installing…" : "Install"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

/** Inline uninstall confirmation (conditional rendering keeps this testable without portals). */
const UninstallConfirm: React.FC<{
  item: AgentPluginListItem;
  busy: boolean;
  onConfirm: (deletePluginData: boolean) => void;
  onCancel: () => void;
}> = (props) => {
  const [deletePluginData, setDeletePluginData] = useState(false);

  return (
    <div className="border-border-medium bg-background-secondary mt-2 space-y-2 rounded-md border p-3">
      <p className="text-foreground text-xs">
        Uninstall <span className="font-medium">{props.item.name}</span>? This removes the plugin
        directory and its workspace MCP overrides.
      </p>
      <label className="text-muted flex items-center gap-2 text-xs">
        <Checkbox
          checked={deletePluginData}
          onCheckedChange={(checked) => setDeletePluginData(checked === true)}
          disabled={props.busy}
        />
        Also delete stored plugin data
      </label>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => props.onConfirm(deletePluginData)}
          disabled={props.busy}
        >
          {props.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {props.busy ? "Uninstalling…" : "Uninstall"}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

export const PluginsSettingsSection: React.FC = () => {
  const { api } = useAPI();
  const [items, setItems] = useState<AgentPluginListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateChecks, setUpdateChecks] = useState<Map<string, AgentPluginUpdateCheck>>(
    () => new Map()
  );
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // Palette intents (keyboard rule: install/uninstall/update need keyboard
  // paths). The initializer covers palette → fresh mount; the subscription
  // below covers commands invoked while this section is already on screen
  // (same-route navigation preserves the mounted component, so no re-init
  // happens).
  const [initialIntent] = useState(() => consumePendingPluginsSectionIntent());
  const [addOpen, setAddOpen] = useState(initialIntent?.type === "open-add-panel");
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(
    initialIntent?.type === "confirm-uninstall" ? initialIntent.name : null
  );
  /** Name of the plugin with an update/uninstall in flight. */
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.agentPlugins.list();
      if (result.success) {
        setItems(result.data);
        setError(null);
      } else {
        setItems([]);
        setError(result.error);
      }
    } catch (err) {
      setItems([]);
      setError(getErrorMessage(err));
    }
  }, [api]);

  const checkForUpdates = useCallback(async () => {
    if (!api) return;
    setCheckingUpdates(true);
    try {
      const result = await api.agentPlugins.checkUpdates();
      if (result.success) {
        setUpdateChecks(new Map(result.data.map((check) => [check.name, check])));
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setCheckingUpdates(false);
    }
  }, [api]);

  // Approved update policy: passive check on section open + explicit button only.
  useEffect(() => {
    void refresh();
    void checkForUpdates();
  }, [refresh, checkForUpdates]);

  // Live palette intents while mounted (see pluginsSectionIntents).
  useEffect(() => {
    return subscribePluginsSectionIntents((intent: PluginsSectionIntent) => {
      switch (intent.type) {
        case "open-add-panel":
          setAddOpen(true);
          break;
        case "confirm-uninstall":
          setUninstallTarget(intent.name);
          break;
        case "refresh":
          void refresh();
          void checkForUpdates();
          break;
      }
    });
  }, [refresh, checkForUpdates]);

  const handleUpdate = useCallback(
    async (name: string) => {
      if (!api || busyPlugin !== null) return;
      setBusyPlugin(name);
      setError(null);
      try {
        const result = await api.agentPlugins.update({ name });
        // Refresh regardless of outcome (the swap may be partially visible),
        // but re-assert the mutation error AFTER the refresh: refresh's
        // success path clears the error state, which would silently swallow
        // the failure the user needs to see.
        await refresh();
        await checkForUpdates();
        if (!result.success) {
          setError(result.error);
        }
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setBusyPlugin(null);
      }
    },
    [api, busyPlugin, refresh, checkForUpdates]
  );

  const handleUninstall = useCallback(
    async (name: string, deletePluginData: boolean) => {
      if (!api || busyPlugin !== null) return;
      setBusyPlugin(name);
      setError(null);
      try {
        const result = await api.agentPlugins.uninstall({ name, deletePluginData });
        if (result.success) {
          setUninstallTarget(null);
          await refresh();
        } else {
          // Keep the confirmation open and surface the error after the list
          // refresh (whose success path clears error state).
          await refresh();
          setError(result.error);
        }
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setBusyPlugin(null);
      }
    },
    [api, busyPlugin, refresh]
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-muted mb-4 text-xs">
          Install Agent Plugins from git repositories into{" "}
          <code className="text-accent">~/.mux/plugins</code>. Plugins contribute skills and
          default-disabled MCP servers. Installs are global (shared by all projects); updates are
          manual, and updating discards any local edits to the plugin directory.
        </p>
      </div>

      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-foreground text-sm font-medium">Installed plugins</h3>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void checkForUpdates()}
              disabled={checkingUpdates}
            >
              {checkingUpdates ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Check for updates
            </Button>
            {!addOpen && (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add plugin
              </Button>
            )}
          </div>
        </div>

        {addOpen && (
          <div className="mb-4">
            <AddPluginPanel
              onInstalled={() => {
                setAddOpen(false);
                void refresh();
                void checkForUpdates();
              }}
              onClose={() => setAddOpen(false)}
            />
          </div>
        )}

        {error && (
          <div className="bg-destructive/10 text-destructive mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <div className="space-y-2">
          {items === null ? (
            <div className="text-muted flex items-center gap-2 py-4 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading plugins…
            </div>
          ) : items.length === 0 ? (
            <p className="text-muted py-2 text-sm">No plugins installed yet.</p>
          ) : (
            items.map((item) => {
              const check = updateChecks.get(item.name);
              const updateAvailable =
                item.managed &&
                (check?.status === "update-available" || check?.status === "tag-moved");
              const isBusy = busyPlugin === item.name;

              return (
                <div
                  key={`${item.location}:${item.name}`}
                  className="border-border-medium rounded-md border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-foreground text-sm font-medium">{item.name}</span>
                        {item.version && (
                          <span className="text-muted text-xs">v{item.version}</span>
                        )}
                        {!item.managed && <Badge tone="muted">unmanaged</Badge>}
                        {item.managed && !item.present && <Badge tone="error">missing</Badge>}
                        {check?.status === "update-available" && (
                          <Badge tone="accent">update available</Badge>
                        )}
                        {check?.status === "tag-moved" && <Badge tone="warning">tag moved</Badge>}
                        {check?.status === "pinned" && <Badge tone="muted">pinned</Badge>}
                        {check?.status === "error" && <Badge tone="warning">check failed</Badge>}
                      </div>
                      {item.description && (
                        <p className="text-muted mt-0.5 text-xs">{item.description}</p>
                      )}
                      <p className="text-muted mt-0.5 text-[11px]">
                        {item.skillCount} skill{item.skillCount === 1 ? "" : "s"} ·{" "}
                        {item.mcpServerCount} MCP server{item.mcpServerCount === 1 ? "" : "s"} ·{" "}
                        <code>{item.location}</code>
                      </p>
                      {formatSource(item) && (
                        <p className="text-muted mt-0.5 text-[11px]">
                          {formatSource(item)}
                          {item.lockedSha ? ` · ${item.lockedSha.slice(0, 12)}` : ""}
                        </p>
                      )}
                      {check?.status === "error" && check.message && (
                        <p className="mt-0.5 flex items-start gap-1 text-[11px] text-yellow-500">
                          <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                          <span className="break-words">{check.message}</span>
                        </p>
                      )}
                    </div>

                    {item.managed && (
                      <div className="flex shrink-0 gap-1">
                        {updateAvailable && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => void handleUpdate(item.name)}
                            disabled={busyPlugin !== null}
                          >
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <ArrowDownToLine className="h-3 w-3" />
                            )}
                            Update
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted hover:text-destructive h-7 px-2 text-xs"
                          onClick={() =>
                            setUninstallTarget(uninstallTarget === item.name ? null : item.name)
                          }
                          disabled={busyPlugin !== null}
                          aria-label={`Uninstall ${item.name}`}
                        >
                          <Trash2 className="h-3 w-3" />
                          Uninstall
                        </Button>
                      </div>
                    )}
                  </div>

                  {uninstallTarget === item.name && (
                    <UninstallConfirm
                      item={item}
                      busy={isBusy}
                      onConfirm={(deletePluginData) =>
                        void handleUninstall(item.name, deletePluginData)
                      }
                      onCancel={() => setUninstallTarget(null)}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
