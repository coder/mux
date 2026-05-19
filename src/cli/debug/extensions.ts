/**
 * Debug command: print the current Extension Snapshot as JSON.
 *
 * Usage: bun debug extensions [--root <rootId>]
 *
 * Mirrors ServiceContainer's root discovery wiring so the output matches
 * what `extensions.list` would return over IPC, including stale approval
 * records derived from `~/.mux/config.json` and Mux-owned project extension
 * state under `~/.mux/extensions/project-state`.
 *
 * Approval records hold an approved capability allowlist and a non-reversible
 * capability-set hash — neither is a credential, so the snapshot passes through
 * verbatim apart from the optional --root filter.
 */
import { rootIdFromPermissionKey } from "@/common/extensions/extensionPermissionKey";
import { defaultConfig } from "@/node/config";
import {
  ExtensionRegistry,
  type RegistrySnapshot,
} from "@/node/extensions/extensionRegistryService";
import { createExtensionRootsProvider } from "@/node/extensions/extensionRoots";
import { GlobalExtensionStateService } from "@/node/extensions/globalExtensionStateService";
import {
  getProjectExtensionStateRoot,
  ProjectExtensionStateService,
} from "@/node/extensions/projectExtensionStateService";

export interface DebugExtensionsOptions {
  rootId?: string;
}

export interface DebugExtensionsOutput {
  generatedAt: number | null;
  filterRootId: string | null;
  snapshot: RegistrySnapshot | null;
}

export async function debugExtensionsCommand(options: DebugExtensionsOptions = {}): Promise<void> {
  const projectState = new ProjectExtensionStateService(
    getProjectExtensionStateRoot(defaultConfig.rootDir)
  );
  const registry = new ExtensionRegistry({
    roots: createExtensionRootsProvider({ config: defaultConfig, projectState }),
    globalState: new GlobalExtensionStateService(defaultConfig),
    projectState,
  });
  await registry.reload();
  const output = formatSnapshotForDebug(registry.getSnapshot(), options);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export function formatSnapshotForDebug(
  snapshot: RegistrySnapshot | null,
  options: DebugExtensionsOptions = {}
): DebugExtensionsOutput {
  const filterRootId = options.rootId ?? null;
  if (snapshot == null) {
    return { generatedAt: null, filterRootId, snapshot: null };
  }
  if (filterRootId == null) {
    return { generatedAt: snapshot.generatedAt, filterRootId, snapshot };
  }

  const matchedRoot = snapshot.roots.find((r) => r.rootId === filterRootId);
  const matchedExtensionIds = new Set((matchedRoot?.extensions ?? []).map((e) => e.extensionId));

  const filteredPermissions: RegistrySnapshot["permissions"] = Object.fromEntries(
    Object.entries(snapshot.permissions).filter(([permissionKey]) => {
      const rootId = rootIdFromPermissionKey(permissionKey);
      if (rootId !== null) return rootId === filterRootId;
      return matchedExtensionIds.has(permissionKey);
    })
  );

  const filtered: RegistrySnapshot = {
    generatedAt: snapshot.generatedAt,
    roots: matchedRoot ? [matchedRoot] : [],
    availableContributions: snapshot.availableContributions.filter(
      (c) => c.rootId === filterRootId
    ),
    // Resolver diagnostics that pin to a specific extension travel with that
    // extension; global-scope resolver diagnostics (no extensionId) are kept
    // so cross-root conflicts remain visible under any --root filter.
    resolverDiagnostics: snapshot.resolverDiagnostics.filter(
      (d) => d.extensionId == null || matchedExtensionIds.has(d.extensionId)
    ),
    descriptors: snapshot.descriptors.filter((d) => d.rootId === filterRootId),
    permissions: filteredPermissions,
    staleRecords: snapshot.staleRecords.filter((s) => s.rootId === filterRootId),
  };

  return { generatedAt: snapshot.generatedAt, filterRootId, snapshot: filtered };
}
