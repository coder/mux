import { useEffect, useRef } from "react";
import type { z } from "zod";

import { requiresReapproval } from "@/common/extensions/approvalDrift";
import type { APIClient } from "@/browser/contexts/API";
import { useAPI } from "@/browser/contexts/API";
import {
  useCommandRegistry,
  type CommandAction,
  type CommandSource,
} from "@/browser/contexts/CommandRegistryContext";
import { CommandIds } from "@/browser/utils/commandIds";
import { COMMAND_SECTIONS } from "@/browser/utils/commands/sources";
import type * as extensionRegistrySchemas from "@/common/orpc/schemas/extensionRegistry";

type RegistrySnapshot = z.infer<typeof extensionRegistrySchemas.RegistrySnapshotSchema>;

interface ResolvedRoots {
  userMissing: boolean;
  primaryPath: string | null;
  driftPending: boolean;
}

function resolveRoots(snapshot: RegistrySnapshot | null): ResolvedRoots {
  if (!snapshot) return { userMissing: false, primaryPath: null, driftPending: false };

  const user = snapshot.roots.find((r) => r.kind === "user-global") ?? null;
  const bundled = snapshot.roots.find((r) => r.kind === "bundled") ?? null;
  const project = snapshot.roots.find((r) => r.kind === "project-local") ?? null;

  const driftPending = Object.values(snapshot.permissions).some((result) =>
    requiresReapproval(result)
  );

  return {
    userMissing: user != null && !user.rootExists,
    primaryPath: user?.path ?? bundled?.path ?? project?.path ?? null,
    driftPending,
  };
}

interface BuildCommandsParams {
  api: APIClient | null;
  snapshot: RegistrySnapshot | null;
  onOpenSettings: (section?: string) => void;
}

export function buildExtensionsPaletteCommands({
  api,
  snapshot,
  onOpenSettings,
}: BuildCommandsParams): CommandAction[] {
  const roots = resolveRoots(snapshot);
  const list: CommandAction[] = [];

  list.push({
    id: CommandIds.extensionsOpenSettings(),
    title: "Open Settings: Extensions",
    subtitle: "Manage installed extensions",
    section: COMMAND_SECTIONS.SETTINGS,
    keywords: ["extension", "extensions", "plugin", "addon", "add-on"],
    run: () => onOpenSettings("extensions"),
  });

  list.push({
    id: CommandIds.extensionsReload(),
    title: "Reload Extensions",
    subtitle: "Re-discover all roots",
    section: COMMAND_SECTIONS.SETTINGS,
    keywords: ["extension", "extensions", "reload", "rediscover", "refresh"],
    enabled: () => api != null,
    run: async () => {
      if (!api) return;
      try {
        await api.extensions.reload({});
      } catch {
        /* surfaced in settings UI */
      }
    },
  });

  list.push({
    id: CommandIds.extensionsInitializeUserRoot(),
    title: "Initialize User Extensions Root",
    subtitle: "Create the user-global extensions directory",
    section: COMMAND_SECTIONS.SETTINGS,
    keywords: ["extension", "extensions", "initialize", "user", "root"],
    visible: () => roots.userMissing,
    enabled: () => api != null,
    run: async () => {
      if (!api) return;
      try {
        await api.extensions.initializeUserRoot();
      } catch {
        /* surfaced in settings UI */
      }
    },
  });

  list.push({
    id: CommandIds.extensionsShowRootPath(),
    title: "Copy Extensions Root Path",
    subtitle: roots.primaryPath ?? undefined,
    section: COMMAND_SECTIONS.SETTINGS,
    keywords: ["extension", "extensions", "root", "path", "copy", "clipboard"],
    enabled: () => roots.primaryPath != null,
    run: async () => {
      const path = roots.primaryPath;
      if (!path) return;
      try {
        await navigator.clipboard.writeText(path);
      } catch {
        /* clipboard may be unavailable; UI alternative exists in settings */
      }
    },
  });

  list.push({
    id: CommandIds.extensionsReviewPending(),
    title: "Review Pending Extension Capabilities",
    subtitle: "Open Extensions settings and surface capability approval drift",
    section: COMMAND_SECTIONS.SETTINGS,
    keywords: ["extension", "extensions", "capabilities", "approval", "drift", "review", "pending"],
    visible: () => roots.driftPending,
    run: () => onOpenSettings("extensions"),
  });

  return list;
}

/**
 * Subscribe to extension snapshot updates and register a command-palette source
 * exposing the Extensions section's operations. The source remains registered
 * across snapshot changes; only the captured snapshot ref updates so command
 * visibility/run reflects current state on each palette open.
 */
export function useExtensionsPaletteSource(
  onOpenSettings: ((section?: string) => void) | undefined
): void {
  const { api } = useAPI();
  const { registerSource } = useCommandRegistry();
  const platformEnabled = onOpenSettings !== undefined;
  const snapshotRef = useRef<RegistrySnapshot | null>(null);
  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;

  useEffect(() => {
    if (!api || !platformEnabled) {
      snapshotRef.current = null;
      return;
    }
    const abort = new AbortController();
    const refresh = async () => {
      try {
        snapshotRef.current = (await api.extensions.list()) ?? null;
      } catch {
        /* expected on shutdown */
      }
    };
    void refresh();
    (async () => {
      try {
        const iter = await api.extensions.onChanged(undefined, { signal: abort.signal });
        for await (const _ of iter) {
          if (abort.signal.aborted) break;
          void refresh();
        }
      } catch {
        /* expected on unmount */
      }
    })();
    return () => abort.abort();
  }, [api, platformEnabled]);

  useEffect(() => {
    if (!platformEnabled) return;
    const source: CommandSource = () => {
      const cb = onOpenSettingsRef.current;
      if (!cb) return [];
      return buildExtensionsPaletteCommands({
        api,
        snapshot: snapshotRef.current,
        onOpenSettings: cb,
      });
    };
    return registerSource(source);
  }, [api, platformEnabled, registerSource]);
}
