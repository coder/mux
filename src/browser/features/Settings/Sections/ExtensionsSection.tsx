import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Info,
  Keyboard,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  XCircle,
} from "lucide-react";
import type { z } from "zod";

import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  formatKeybind,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { requiresReapproval } from "@/common/extensions/approvalDrift";
import { extensionPermissionKey } from "@/common/extensions/extensionPermissionKey";
import type * as extensionRegistrySchemas from "@/common/orpc/schemas/extensionRegistry";
import { ConsentShortcutModal } from "./ConsentShortcutModal";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
import { ExtensionCard, getExtensionCardTestId, StaleRecordCard } from "./ExtensionCard";
import { ExtensionsCheatSheetModal } from "./ExtensionsCheatSheetModal";
import { logSnapshotDiagnostics, rootSubsectionDiagnostics } from "./extensionDiagnostics";

type ExtensionDiagnostic = z.infer<typeof extensionRegistrySchemas.ExtensionDiagnosticSchema>;
type RegistrySnapshot = z.infer<typeof extensionRegistrySchemas.RegistrySnapshotSchema>;
type RootDiscoveryResult = z.infer<typeof extensionRegistrySchemas.RootDiscoveryResultSchema>;
type RootKind = z.infer<typeof extensionRegistrySchemas.RootKindSchema>;
type DiscoveredExtension = z.infer<typeof extensionRegistrySchemas.DiscoveredExtensionSchema>;
type CalculatePermissionsResult = z.infer<
  typeof extensionRegistrySchemas.CalculatePermissionsResultSchema
>;
type StaleRecord = z.infer<typeof extensionRegistrySchemas.StaleRecordSchema>;

const ROOT_LABELS: Record<RootKind, string> = {
  bundled: "Bundled",
  "user-global": "User-global",
  "project-local": "Project-local",
};

interface AggregateCounts {
  errors: number;
  warnings: number;
}

function aggregateDiagnostics(snapshot: RegistrySnapshot | null): AggregateCounts {
  if (!snapshot) return { errors: 0, warnings: 0 };

  let errors = 0;
  let warnings = 0;

  const tally = (severity: string) => {
    if (severity === "error") errors++;
    else if (severity === "warn") warnings++;
  };

  for (const root of snapshot.roots) {
    for (const d of root.diagnostics) tally(d.severity);
    for (const ext of root.extensions) {
      for (const d of ext.diagnostics) tally(d.severity);
    }
  }
  for (const d of snapshot.resolverDiagnostics) tally(d.severity);

  return { errors, warnings };
}

function describePlatformState(snapshot: RegistrySnapshot | null): string {
  if (!snapshot) return "Loading…";

  const states = snapshot.roots.map((r) => r.state);
  if (states.some((s) => s === "running" || s === "pending")) return "Discovering…";
  if (states.some((s) => s === "failed")) return "Discovery completed with failures";
  if (states.length === 0) return "No extension roots configured";
  return "Ready";
}

function findRoot(snapshot: RegistrySnapshot | null, kind: RootKind): RootDiscoveryResult | null {
  if (!snapshot) return null;
  return snapshot.roots.find((r) => r.kind === kind) ?? null;
}

function extensionCardKey(extension: Pick<DiscoveredExtension, "rootId" | "extensionId">): string {
  return extensionPermissionKey(extension.rootId, extension.extensionId);
}

function getRootSections(
  snapshot: RegistrySnapshot | null
): Array<{ key: string; kind: RootKind; root: RootDiscoveryResult | null }> {
  const roots = snapshot?.roots ?? [];
  const userGlobalRoots = roots.filter((root) => root.kind === "user-global");
  return [
    { key: "bundled", kind: "bundled" as const, root: findRoot(snapshot, "bundled") },
    ...(userGlobalRoots.length > 0
      ? userGlobalRoots.map((root) => ({ key: root.rootId, kind: "user-global" as const, root }))
      : [{ key: "user-global", kind: "user-global" as const, root: null }]),
    ...roots
      .filter((root) => root.kind === "project-local")
      .map((root) => ({ key: root.rootId, kind: "project-local" as const, root })),
  ];
}

function hasPendingPermissionDrift(snapshot: RegistrySnapshot | null): boolean {
  if (!snapshot) return false;
  return Object.values(snapshot.permissions).some((result) => requiresReapproval(result));
}

interface ExtensionActionHandlers {
  onReload: (rootId: string, extensionId: string) => void | Promise<void>;
  onEnable: (rootId: string, extensionId: string) => void | Promise<void>;
  onDisable: (rootId: string, extensionId: string) => void | Promise<void>;
  onGrant: (rootId: string, extensionId: string) => void | Promise<void>;
  onRevoke: (rootId: string, extensionId: string) => void | Promise<void>;
  onQuickSetup: (rootId: string, extensionId: string) => void;
}

interface RootSubsectionProps extends ExtensionActionHandlers {
  kind: RootKind;
  root: RootDiscoveryResult | null;
  isInitializing: boolean;
  permissions: Record<string, CalculatePermissionsResult | undefined>;
  resolverDiagnostics: readonly ExtensionDiagnostic[];
  expandedExtensionKey: string | null;
  focusedExtensionKey: string | null;
  onReloadRoot: (rootId?: string) => void;
  onInitializeUserRoot: () => void;
  onTrustRoot: (rootId: string) => void;
  onUntrustRoot: (rootId: string) => void;
}

const RootSubsection: React.FC<RootSubsectionProps> = ({
  kind,
  root,
  isInitializing,
  permissions,
  resolverDiagnostics,
  expandedExtensionKey,
  focusedExtensionKey,
  onReloadRoot,
  onInitializeUserRoot,
  onTrustRoot,
  onUntrustRoot,
  onReload,
  onEnable,
  onDisable,
  onGrant,
  onRevoke,
  onQuickSetup,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  // Project-local: missing dir → hide subsection entirely.
  if (kind === "project-local" && !root?.rootExists) {
    return null;
  }

  const label = ROOT_LABELS[kind];
  const rootDomId = root?.rootId ?? kind;
  const baseExtensions = root?.extensions ?? [];
  const extensions = baseExtensions.map((ext: DiscoveredExtension) => {
    const diagnostics: ExtensionDiagnostic[] = resolverDiagnostics.filter(
      (diag) =>
        diag.extensionId === ext.extensionId && (diag.rootId == null || diag.rootId === ext.rootId)
    );
    return diagnostics.length > 0
      ? { ...ext, diagnostics: [...ext.diagnostics, ...diagnostics] }
      : ext;
  });
  const rootWithResolverDiagnostics = root ? { ...root, extensions } : null;
  const rootUntrusted = root != null && kind === "project-local" && !root.trusted;
  const rootTrusted = root != null && kind === "project-local" && root.trusted;
  const inspectionOnly = rootUntrusted;

  return (
    <div
      className="border-border-light overflow-hidden rounded-md border"
      data-testid={`root-subsection-${rootDomId}`}
    >
      <div className="bg-background-secondary flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          className="text-foreground hover:text-accent flex items-center gap-1 text-sm font-medium"
          aria-expanded={!collapsed}
          aria-controls={`extensions-root-${rootDomId}`}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          <span>{label}</span>
          <span className="text-muted text-xs font-normal">
            ({extensions.length} {extensions.length === 1 ? "extension" : "extensions"})
          </span>
          {root?.state === "failed" && (
            <span
              className="bg-error/15 text-error border-error/40 ml-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
              data-testid={`root-failed-${kind}`}
            >
              <XCircle className="h-3 w-3" />
              Failed
            </span>
          )}
        </button>
        <div className="flex items-center gap-2">
          {root?.state === "failed" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReloadRoot(root.rootId)}
              aria-label={`Retry ${kind} discovery`}
              data-testid={`root-retry-${kind}`}
            >
              <RotateCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          )}
          {root && rootUntrusted && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onTrustRoot(root.rootId)}
              aria-label="Trust this root"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Trust this root
            </Button>
          )}
          {root && rootTrusted && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onUntrustRoot(root.rootId)}
              aria-label="Untrust this root"
            >
              <ShieldOff className="h-3.5 w-3.5" />
              Untrust
            </Button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div id={`extensions-root-${rootDomId}`} className="space-y-2 px-3 py-3">
          {root?.path && <p className="text-muted font-mono text-xs break-all">{root.path}</p>}

          <RootDiagnostics root={rootWithResolverDiagnostics} kind={kind} />

          <RootEmptyState
            kind={kind}
            root={root}
            isInitializing={isInitializing}
            onInitializeUserRoot={onInitializeUserRoot}
            onReload={onReloadRoot}
          />

          {extensions.length > 0 && (
            <div className="space-y-2">
              {rootUntrusted && (
                <p className="text-muted text-xs">
                  Project-local root is untrusted. Cards are shown in inspection-only mode.
                </p>
              )}
              {extensions.map((ext) => (
                <ExtensionCard
                  key={`${ext.rootId}:${ext.extensionId}`}
                  extension={ext}
                  permissions={
                    permissions[extensionPermissionKey(ext.rootId, ext.extensionId)] ??
                    permissions[ext.extensionId] ??
                    null
                  }
                  inspectionOnly={inspectionOnly}
                  forceExpanded={expandedExtensionKey === extensionCardKey(ext)}
                  focused={focusedExtensionKey === extensionCardKey(ext)}
                  onReload={onReload}
                  onEnable={onEnable}
                  onDisable={onDisable}
                  onGrant={onGrant}
                  onRevoke={onRevoke}
                  onQuickSetup={onQuickSetup}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface RootDiagnosticsProps {
  root: RootDiscoveryResult | null;
  kind: RootKind;
}

const SEVERITY_ICON = {
  error: XCircle,
  warn: AlertTriangle,
  info: Info,
} as const;

const SEVERITY_COLOR = {
  error: "text-error",
  warn: "text-warning",
  info: "text-muted",
} as const;

const RootDiagnostics: React.FC<RootDiagnosticsProps> = ({ root, kind }) => {
  if (!root) return null;
  // Mirror extension-level error / conflict / root-level diagnostics so the
  // root subsection can summarize blocking issues without forcing the user to
  // expand every card. Unclassified codes still flow through their snapshot
  // surface (root.diagnostics already prints; cards already print their own).
  const items = rootSubsectionDiagnostics(root);
  if (items.length === 0) return null;

  return (
    <ul
      className="space-y-1.5"
      data-testid={`root-diagnostics-${kind}`}
      aria-label={`${kind} root diagnostics`}
    >
      {items.map((d, idx) => {
        const Icon = SEVERITY_ICON[d.severity];
        return (
          <li
            key={`${d.code}:${idx}`}
            className="flex items-start gap-2 text-xs"
            data-diagnostic-code={d.code}
            data-diagnostic-severity={d.severity}
          >
            <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${SEVERITY_COLOR[d.severity]}`} />
            <div className="min-w-0">
              <div className="text-foreground break-words">
                <span className="font-mono text-[11px]">{d.code}</span>
                {d.extensionId && (
                  <span className="text-muted ml-2 font-mono text-[11px]">{d.extensionId}</span>
                )}
              </div>
              <div className="text-muted mt-0.5 break-words">{d.message}</div>
              {d.suggestedAction && (
                <div className="text-muted mt-0.5 break-words italic">{d.suggestedAction}</div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
};

interface RootEmptyStateProps {
  kind: RootKind;
  root: RootDiscoveryResult | null;
  isInitializing: boolean;
  onReload: (rootId?: string) => void;
  onInitializeUserRoot: () => void;
}

function isProjectLockInspectionRoot(root: RootDiscoveryResult): boolean {
  return root.path.endsWith("/.mux") || root.path.endsWith("\\.mux");
}

const RootEmptyState: React.FC<RootEmptyStateProps> = ({
  kind,
  root,
  isInitializing,
  onReload,
  onInitializeUserRoot,
}) => {
  if (!root) return null;
  if (root.extensions.length > 0) return null;

  if (kind === "bundled") {
    // Spec: bundled is never empty in v1; but if it appears empty (e.g. dev-server
    // before assembly), fall through and avoid surfacing a confusing CTA.
    return (
      <p className="text-muted text-xs">
        No bundled extensions detected. The packaged app should always include at least one.
      </p>
    );
  }

  if (kind === "user-global") {
    if (!root.rootExists) {
      return (
        <div className="space-y-2">
          <p className="text-muted text-xs">
            No user-global Extensions root has been initialized yet. Mux can create the directory so
            you can drop Extension Modules into it; this only sets up the folder and never approves
            any capabilities.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onInitializeUserRoot}
            disabled={isInitializing}
            aria-label="Initialize User Extensions Root"
          >
            {isInitializing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Initialize User Extensions Root
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <p className="text-muted text-xs">
          User-global root is initialized but contains no Extension Modules. Create a module folder,
          add extension.ts, then reload:
        </p>
        <pre className="bg-background-tertiary text-foreground overflow-x-auto rounded px-2 py-1 font-mono text-xs">
          {`mkdir -p ${root.path}/acme-review && $EDITOR ${root.path}/acme-review/extension.ts`}
        </pre>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onReload(root.rootId)}
          aria-label="Reload user-global extensions root"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Reload
        </Button>
      </div>
    );
  }

  // project-local: present + project untrusted (root.trusted === false at the root level
  // is shown via the header trust button; an empty project-local root just shows a hint).
  if (kind === "project-local") {
    if (!root.trusted && isProjectLockInspectionRoot(root)) {
      return (
        <div className="border-warning/30 bg-warning/10 text-warning rounded-md border px-3 py-2 text-xs">
          <p>
            This project declares extension sources in{" "}
            <code className="font-mono">.mux/extensions.lock.json</code>. Before trust, Mux shows
            the declaration only; sources are not fetched, parsed, or executed.
          </p>
        </div>
      );
    }
    if (!root.trusted) {
      return (
        <div className="border-warning/30 bg-warning/10 text-warning rounded-md border px-3 py-2 text-xs">
          <p>
            This project&apos;s local Extensions root has not been trusted. Trust the project (or
            this root) to allow Mux to discover Extensions from the
            <code className="font-mono">.mux/extensions</code> directory.
          </p>
        </div>
      );
    }
    return (
      <p className="text-muted text-xs">
        Project-local root is trusted but contains no Extensions yet.
      </p>
    );
  }

  return null;
};

interface ConsentTarget {
  extension: DiscoveredExtension;
  permissions: CalculatePermissionsResult | null;
  /** Project-local + untrusted root → transaction includes Trust Root. */
  requiresTrustRoot: boolean;
}

type DestructiveAction =
  | { kind: "disable"; rootId: string; extensionId: string; displayName: string }
  | { kind: "revoke"; rootId: string; extensionId: string; displayName: string }
  | { kind: "untrustRoot"; rootId: string; rootPath: string };

export const ExtensionsSection: React.FC = () => {
  const { api } = useAPI();
  const { copied, copyToClipboard } = useCopyToClipboard();
  const [snapshot, setSnapshot] = useState<RegistrySnapshot | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [consentTarget, setConsentTarget] = useState<ConsentTarget | null>(null);
  const [destructiveAction, setDestructiveAction] = useState<DestructiveAction | null>(null);
  // Root-scoped keys keep conflicted duplicate extension IDs independently navigable.
  const [expandedExtensionKey, setExpandedExtensionKey] = useState<string | null>(null);
  const [focusedExtensionKey, setFocusedExtensionKey] = useState<string | null>(null);
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  const sectionRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.extensions.list();
      setSnapshot(next ?? null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to load extensions");
    }
  }, [api]);

  // Each snapshot replacement triggers a one-shot pass that emits structured
  // log entries for every matrix-relevant diagnostic and derived state. We key
  // on `generatedAt` so a re-render with the same snapshot does not duplicate
  // log lines, and so previous-snapshot diagnostics never leak across.
  const lastLoggedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    if (lastLoggedRef.current === snapshot.generatedAt) return;
    lastLoggedRef.current = snapshot.generatedAt;
    logSnapshotDiagnostics(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (!api) return;
    const abort = new AbortController();
    void refresh();
    (async () => {
      try {
        const iter = await api.extensions.onChanged(undefined, { signal: abort.signal });
        for await (const _ of iter) {
          if (abort.signal.aborted) break;
          void refresh();
        }
      } catch {
        // Expected on unmount.
      }
    })();
    return () => abort.abort();
  }, [api, refresh]);

  const handleReload = useCallback(
    async (rootId?: string) => {
      if (!api) return;
      setIsReloading(true);
      setActionError(null);
      try {
        await api.extensions.reload(rootId ? { rootId } : {});
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to reload extensions");
      } finally {
        setIsReloading(false);
      }
    },
    [api]
  );

  const handleInitializeUserRoot = useCallback(async () => {
    if (!api) return;
    setIsInitializing(true);
    setActionError(null);
    try {
      await api.extensions.initializeUserRoot();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to initialize user extensions root"
      );
    } finally {
      setIsInitializing(false);
    }
  }, [api]);

  const handleTrustRoot = useCallback(
    async (rootId: string) => {
      if (!api) return;
      setActionError(null);
      try {
        await api.extensions.trustRoot({ rootId });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Failed to trust extension root");
      }
    },
    [api]
  );

  // Per-extension action wrappers shared across cards. Each runs against the
  // extensions IPC then triggers a refresh; failures surface in the section's
  // action-error banner so a single card cannot swallow them silently.
  const runExtensionAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      if (!api) return;
      setActionError(null);
      try {
        await action();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `Failed to ${label}`);
      }
    },
    [api]
  );

  const handleEnableExtension = useCallback(
    (rootId: string, extensionId: string) =>
      runExtensionAction("enable extension", () => api!.extensions.enable({ rootId, extensionId })),
    [api, runExtensionAction]
  );
  const handleGrantExtension = useCallback(
    (rootId: string, extensionId: string) =>
      runExtensionAction("approve extension capabilities", () =>
        api!.extensions.approve({ rootId, extensionId })
      ),
    [api, runExtensionAction]
  );
  const handleReloadExtension = useCallback(
    (rootId: string, _extensionId: string) =>
      runExtensionAction("reload extension", () => api!.extensions.reload({ rootId })),
    [api, runExtensionAction]
  );
  const handleForgetStale = useCallback(
    (rootId: string, extensionId: string) =>
      runExtensionAction("forget stale record", () =>
        api!.extensions.forgetStale({ rootId, extensionId })
      ),
    [api, runExtensionAction]
  );

  // Destructive actions never bypass confirmation: clicking the per-card
  // Disable / Revoke buttons (or the project-local Untrust header button) opens
  // a confirmation dialog that lists the consequences before invoking the IPC.
  const findExtension = useCallback(
    (rootId: string, extensionId: string): DiscoveredExtension | null => {
      if (!snapshot) return null;
      for (const root of snapshot.roots) {
        if (root.rootId !== rootId) continue;
        return root.extensions.find((e) => e.extensionId === extensionId) ?? null;
      }
      return null;
    },
    [snapshot]
  );

  const handleRequestDisable = useCallback(
    (rootId: string, extensionId: string) => {
      const ext = findExtension(rootId, extensionId);
      const displayName = ext?.manifest.displayName ?? extensionId;
      setDestructiveAction({ kind: "disable", rootId, extensionId, displayName });
    },
    [findExtension]
  );
  const handleRequestRevoke = useCallback(
    (rootId: string, extensionId: string) => {
      const ext = findExtension(rootId, extensionId);
      const displayName = ext?.manifest.displayName ?? extensionId;
      setDestructiveAction({ kind: "revoke", rootId, extensionId, displayName });
    },
    [findExtension]
  );
  const handleRequestUntrustRoot = useCallback(
    (rootId: string) => {
      const root = snapshot?.roots.find((r) => r.rootId === rootId);
      setDestructiveAction({
        kind: "untrustRoot",
        rootId,
        rootPath: root?.path ?? rootId,
      });
    },
    [snapshot]
  );

  const handleConfirmDestructive = useCallback(async () => {
    if (!api || !destructiveAction) return;
    const action = destructiveAction;
    setDestructiveAction(null);
    if (action.kind === "disable") {
      await runExtensionAction("disable extension", () =>
        api.extensions.disable({ rootId: action.rootId, extensionId: action.extensionId })
      );
    } else if (action.kind === "revoke") {
      await runExtensionAction("revoke extension approvals", () =>
        api.extensions.revokeApproval({ rootId: action.rootId, extensionId: action.extensionId })
      );
    } else {
      await runExtensionAction("untrust extension root", () =>
        api.extensions.untrustRoot({ rootId: action.rootId })
      );
    }
  }, [api, destructiveAction, runExtensionAction]);

  // Quick Setup opens the Consent Shortcut Modal. The section computes whether
  // the affected root needs trusting in the same transaction so the modal can
  // accurately summarize consequences.
  const handleQuickSetup = useCallback(
    (rootId: string, extensionId: string) => {
      const ext = findExtension(rootId, extensionId);
      if (!ext) return;
      const root = snapshot?.roots.find((r) => r.rootId === rootId) ?? null;
      const requiresTrustRoot = root?.kind === "project-local" && !root.trusted;
      setConsentTarget({
        extension: ext,
        permissions:
          snapshot?.permissions[extensionPermissionKey(rootId, extensionId)] ??
          snapshot?.permissions[extensionId] ??
          null,
        requiresTrustRoot,
      });
    },
    [findExtension, snapshot]
  );

  const handleConsentConfirm = useCallback(async () => {
    if (!api || !consentTarget) return;
    const target = consentTarget;
    setActionError(null);
    setConsentTarget(null);
    let trustedRoot = false;
    let enabledExtension = false;
    try {
      if (target.requiresTrustRoot) {
        await api.extensions.trustRoot({ rootId: target.extension.rootId });
        trustedRoot = true;
      }
      if (!target.extension.enabled) {
        await api.extensions.enable({
          rootId: target.extension.rootId,
          extensionId: target.extension.extensionId,
        });
        enabledExtension = true;
      }
      await api.extensions.approve({
        rootId: target.extension.rootId,
        extensionId: target.extension.extensionId,
      });
    } catch (err) {
      if (enabledExtension) {
        try {
          await api.extensions.disable({
            rootId: target.extension.rootId,
            extensionId: target.extension.extensionId,
          });
        } catch {
          // Preserve the original setup error; the user can retry or disable manually.
        }
      }
      if (trustedRoot) {
        try {
          await api.extensions.untrustRoot({ rootId: target.extension.rootId });
        } catch {
          // Preserve the original setup error; the user can retry or untrust manually.
        }
      }
      setActionError(err instanceof Error ? err.message : "Failed to apply consent shortcut");
    }
  }, [api, consentTarget]);

  const handleConsentReviewIndividually = useCallback(() => {
    if (!consentTarget) return;
    setExpandedExtensionKey(extensionCardKey(consentTarget.extension));
    setConsentTarget(null);
  }, [consentTarget]);

  const aggregate = useMemo(() => aggregateDiagnostics(snapshot), [snapshot]);
  const platformState = describePlatformState(snapshot);
  const driftPending = useMemo(() => hasPendingPermissionDrift(snapshot), [snapshot]);

  const orderedExtensions = useMemo(() => {
    if (!snapshot) return [] as readonly DiscoveredExtension[];
    const out: DiscoveredExtension[] = [];
    for (const section of getRootSections(snapshot)) {
      if (!section.root) continue;
      for (const ext of section.root.extensions) out.push(ext);
    }
    return out;
  }, [snapshot]);

  const userGlobalRoot = findRoot(snapshot, "user-global");
  const userRootMissing = userGlobalRoot != null && !userGlobalRoot.rootExists;

  const firstUntrustedProjectLocalRoot = snapshot?.roots.find(
    (root) => root.kind === "project-local" && root.rootExists && !root.trusted
  );

  const handleTrustProjectLocal = useCallback(() => {
    if (!firstUntrustedProjectLocalRoot) return;
    void handleTrustRoot(firstUntrustedProjectLocalRoot.rootId);
  }, [firstUntrustedProjectLocalRoot, handleTrustRoot]);

  // Section-local keyboard shortcuts. Listener runs only while this component
  // is mounted (i.e., the user is on the Extensions settings tab); editable
  // elements bypass shortcuts so typing in any input still works.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (isEditableElement(e.target)) return;
      if (consentTarget || destructiveAction) return;

      if (matchesKeybind(e, KEYBINDS.EXTENSIONS_CHEATSHEET)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        setCheatSheetOpen((prev) => !prev);
        return;
      }

      // Cheat sheet swallows all other shortcuts so users can dismiss it
      // before issuing the next command without surprises.
      if (cheatSheetOpen) return;

      if (matchesKeybind(e, KEYBINDS.EXTENSIONS_RELOAD)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        void handleReload();
        return;
      }
      if (matchesKeybind(e, KEYBINDS.EXTENSIONS_TRUST_ROOT)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        handleTrustProjectLocal();
        return;
      }
      if (orderedExtensions.length === 0) return;

      if (matchesKeybind(e, KEYBINDS.EXTENSIONS_NAVIGATE_NEXT)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        const idx = orderedExtensions.findIndex(
          (ext) => extensionCardKey(ext) === focusedExtensionKey
        );
        const next =
          orderedExtensions[Math.min(idx + 1, orderedExtensions.length - 1)] ??
          orderedExtensions[0];
        if (next) setFocusedExtensionKey(extensionCardKey(next));
        return;
      }
      if (matchesKeybind(e, KEYBINDS.EXTENSIONS_NAVIGATE_PREV)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        const idx = orderedExtensions.findIndex(
          (ext) => extensionCardKey(ext) === focusedExtensionKey
        );
        const prev = orderedExtensions[Math.max(idx - 1, 0)] ?? orderedExtensions[0];
        if (prev) setFocusedExtensionKey(extensionCardKey(prev));
        return;
      }
      if (!focusedExtensionKey) return;
      const focused = orderedExtensions.find(
        (ext) => extensionCardKey(ext) === focusedExtensionKey
      );
      if (!focused) return;

      if (
        matchesKeybind(e, KEYBINDS.EXTENSIONS_EXPAND_ENTER) ||
        matchesKeybind(e, KEYBINDS.EXTENSIONS_EXPAND_SPACE)
      ) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        const focusedKey = extensionCardKey(focused);
        setExpandedExtensionKey((current) => (current === focusedKey ? null : focusedKey));
        return;
      }
      if (matchesKeybind(e, KEYBINDS.EXTENSIONS_TOGGLE_ENABLE)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        if (focused.enabled) handleRequestDisable(focused.rootId, focused.extensionId);
        else void handleEnableExtension(focused.rootId, focused.extensionId);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.EXTENSIONS_GRANT)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        handleQuickSetup(focused.rootId, focused.extensionId);
        return;
      }
      if (matchesKeybind(e, KEYBINDS.EXTENSIONS_DIAGNOSTICS)) {
        e.preventDefault();
        stopKeyboardPropagation(e);
        // Force-expand so the diagnostics block is visible, then scroll the
        // focused card into view. Section uses `expandedExtensionKey` as the
        // single force-expand slot so other expansions stay user-driven.
        setExpandedExtensionKey(extensionCardKey(focused));
        const el = sectionRef.current?.querySelector(
          `[data-testid="${getExtensionCardTestId(focused)}"]`
        );
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    cheatSheetOpen,
    consentTarget,
    destructiveAction,
    focusedExtensionKey,
    handleEnableExtension,
    handleQuickSetup,
    handleReload,
    handleRequestDisable,
    handleTrustProjectLocal,
    orderedExtensions,
  ]);

  // Auto-scroll the newly focused card into view (J/K navigation).
  useEffect(() => {
    if (!focusedExtensionKey) return;
    const focused = orderedExtensions.find((ext) => extensionCardKey(ext) === focusedExtensionKey);
    if (!focused) return;
    const el = sectionRef.current?.querySelector(
      `[data-testid="${getExtensionCardTestId(focused)}"]`
    );
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusedExtensionKey, orderedExtensions]);

  // Resolve the root path the action row's copy button targets.
  // Prefer user-global; fall back to bundled then project-local.
  const primaryRootPath =
    userGlobalRoot?.path ??
    findRoot(snapshot, "bundled")?.path ??
    findRoot(snapshot, "project-local")?.path ??
    "";

  return (
    <div className="space-y-6" ref={sectionRef}>
      {/* Header: platform-state line + aggregate counts (errors + warnings only). */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-foreground text-base font-semibold">Extensions</h2>
          <Button
            variant="ghost"
            size="sm"
            className="mobile-hide-shortcut-hints"
            onClick={() => setCheatSheetOpen(true)}
            aria-label="Show extensions cheat sheet"
          >
            <Keyboard className="h-3.5 w-3.5" />
            {/* Match the kbd styling inside ExtensionsCheatSheetModal so the
                trigger reads as the same hotkey users see in the cheat sheet,
                instead of low-contrast plain text on a transparent button. */}
            <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-[11px]">
              {formatKeybind(KEYBINDS.EXTENSIONS_CHEATSHEET)}
            </kbd>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-muted">
            Platform state: <span className="text-foreground">{platformState}</span>
          </span>
          <span className="text-destructive flex items-center gap-1">
            <XCircle className="h-3 w-3" />
            {aggregate.errors} {aggregate.errors === 1 ? "error" : "errors"}
          </span>
          <span className="text-warning flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {aggregate.warnings} {aggregate.warnings === 1 ? "warning" : "warnings"}
          </span>
        </div>
      </div>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleReload()}
          disabled={isReloading || !api}
          aria-label="Reload Extensions"
        >
          {isReloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Reload Extensions
        </Button>

        {userRootMissing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleInitializeUserRoot()}
            disabled={isInitializing || !api}
            aria-label="Initialize User Extensions Root"
          >
            {isInitializing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Initialize User Extensions Root
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={() => void copyToClipboard(primaryRootPath)}
          disabled={!primaryRootPath}
          aria-label="Copy Extensions Root Path"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Path copied" : "Copy Extensions Root Path"}
        </Button>

        {driftPending && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Drift review surfaces inside per-extension cards (each card's
              // "Re-approve pending" action). Scrolling to the cards list is the
              // simplest jump-to affordance until a dedicated drift filter ships.
              const el = document.getElementById("extensions-roots-list");
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            aria-label="Review Pending Extension Capabilities"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            Review Pending Extension Capabilities
          </Button>
        )}
      </div>

      {actionError && (
        <div className="bg-destructive/10 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-xs">
          <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{actionError}</span>
        </div>
      )}

      {snapshot === null ? (
        <div className="border-border-light bg-background-secondary text-muted-foreground rounded-md border px-3 py-4 text-sm">
          Loading extension registry…
        </div>
      ) : (
        <div id="extensions-roots-list" className="space-y-3">
          {getRootSections(snapshot).map(({ key, kind, root }) => (
            <RootSubsection
              key={key}
              kind={kind}
              root={root}
              isInitializing={isInitializing}
              permissions={snapshot?.permissions ?? {}}
              resolverDiagnostics={snapshot.resolverDiagnostics}
              expandedExtensionKey={expandedExtensionKey}
              focusedExtensionKey={focusedExtensionKey}
              onReloadRoot={(rootId) => void handleReload(rootId)}
              onInitializeUserRoot={() => void handleInitializeUserRoot()}
              onTrustRoot={(rootId) => void handleTrustRoot(rootId)}
              onUntrustRoot={handleRequestUntrustRoot}
              onReload={handleReloadExtension}
              onEnable={handleEnableExtension}
              onDisable={handleRequestDisable}
              onGrant={handleGrantExtension}
              onRevoke={handleRequestRevoke}
              onQuickSetup={handleQuickSetup}
            />
          ))}
        </div>
      )}

      {snapshot?.staleRecords && snapshot.staleRecords.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-foreground text-sm font-semibold">Stale Approval Records</h3>
          <p className="text-muted text-xs">
            Approval records that no longer match a present Extension. Forget the record to clear
            its capability approvals, or keep it for the case where the Extension reappears.
          </p>
          <div className="space-y-2">
            {snapshot.staleRecords.map((record: StaleRecord) => (
              <StaleRecordCard
                key={`${record.rootId}:${record.extensionId}`}
                record={record}
                onForget={(rootId, extensionId) => void handleForgetStale(rootId, extensionId)}
              />
            ))}
          </div>
        </div>
      )}

      <ConsentShortcutModal
        isOpen={consentTarget !== null}
        extension={consentTarget?.extension ?? null}
        permissions={consentTarget?.permissions ?? null}
        requiresTrustRoot={consentTarget?.requiresTrustRoot ?? false}
        onConfirm={() => void handleConsentConfirm()}
        onReviewIndividually={handleConsentReviewIndividually}
        onClose={() => setConsentTarget(null)}
      />

      {destructiveAction && (
        <DestructiveConfirmDialog
          isOpen
          {...describeDestructiveAction(destructiveAction)}
          onConfirm={() => void handleConfirmDestructive()}
          onClose={() => setDestructiveAction(null)}
        />
      )}

      <ExtensionsCheatSheetModal isOpen={cheatSheetOpen} onClose={() => setCheatSheetOpen(false)} />
    </div>
  );
};

interface DestructiveDialogCopy {
  title: string;
  description: string;
  consequences: readonly string[];
  confirmLabel: string;
}

function describeDestructiveAction(action: DestructiveAction): DestructiveDialogCopy {
  switch (action.kind) {
    case "disable":
      return {
        title: `Disable ${action.displayName}?`,
        description:
          "Disabling this Extension stops its contributions from being available until it is re-enabled.",
        consequences: [
          "All contributions from this Extension become unavailable.",
          "Existing approval record is preserved; re-enabling restores the prior capability approvals.",
        ],
        confirmLabel: "Disable",
      };
    case "revoke":
      return {
        title: `Revoke approvals for ${action.displayName}?`,
        description:
          "Revoking approvals withdraws every effect capability previously approved for this Extension.",
        consequences: [
          "Effect capabilities return to the unapproved state.",
          "The Extension stays enabled but cannot use revoked capabilities until re-approved.",
          "Registration capabilities are unaffected.",
        ],
        confirmLabel: "Revoke approval",
      };
    case "untrustRoot":
      return {
        title: "Untrust this Extensions root?",
        description: `Untrusting ${action.rootPath} switches every Extension under that root into inspection-only mode.`,
        consequences: [
          "Extensions in this root run in inspection-only mode.",
          "Project-wide trust is revoked, so repo-controlled hooks and scripts stay disabled.",
          "Any active enablement / approval state is suspended until the root is trusted again.",
          "Existing approval records remain on disk and are restored when trust is re-applied.",
        ],
        confirmLabel: "Untrust root",
      };
  }
}
