import { EventEmitter } from "events";

import { extensionPermissionKey } from "@/common/extensions/extensionPermissionKey";
import {
  resolveConflicts,
  type AvailableContribution,
  type CandidateContribution,
  type CandidateExtension,
} from "@/common/extensions/conflictResolver";
import type {
  ExtensionStateRecord,
  ApprovalRecord,
} from "@/common/extensions/globalExtensionState";
import {
  CONTRIBUTION_TYPE_REGISTRATION_PERMISSIONS,
  type ExtensionDiagnostic,
  type RootKind,
} from "@/common/extensions/manifestValidator";
import {
  calculatePermissions,
  hashRequestedPermissions,
  requiresReapproval,
  type CalculatePermissionsResult,
  type ContributionPermissionRequirement,
} from "@/common/extensions/permissionCalculator";
import type { NormalizedProjectExtensionState } from "@/common/extensions/projectExtensionState";
import type { NormalizedGlobalExtensionState } from "@/common/extensions/globalExtensionState";
import {
  discoverExtensions,
  type DiscoverExtensionsInput,
  type DiscoveredContribution,
  type DiscoveredExtension,
  type DiscoveryStateLookup,
  type DiscoveryStateLookupContext,
  type ExtensionRootDescriptor,
  type ExtensionSnapshot as DiscoverySnapshot,
  type RootDiscoveryResult,
} from "@/node/extensions/extensionDiscoveryService";
import type { ExtensionSkillSource } from "@/common/extensions/extensionSkillSource";
import type { ExtensionActivationSession } from "@/node/extensions/extensionRegistrationDiscoveryService";
import type { GlobalExtensionStateService } from "@/node/extensions/globalExtensionStateService";
import type { ProjectExtensionStateService } from "@/node/extensions/projectExtensionStateService";
import { log } from "@/node/services/log";
import type { SnapshotCacheService } from "@/node/extensions/snapshotCacheService";

export type ExtensionScope =
  | { kind: "global"; rootId?: string; rootKind?: Extract<RootKind, "bundled" | "user-global"> }
  | { kind: "project-local"; projectPath: string };

export type UnavailableReason =
  | "untrusted-root"
  | "disabled"
  | "ungranted"
  | "missing-permissions"
  | "pending-reapproval"
  | "body-failed"
  | "not-activated"
  | "inspection-only"
  | "conflict";

export interface InspectionDescriptor {
  type: string;
  id: string;
  extensionId: string;
  rootId: string;
  rootKind: RootKind;
  available: boolean;
  unavailableReasons: UnavailableReason[];
  missingPermissions: string[];
}

export interface StaleRecord {
  scope: "global" | "project-local";
  // Set when scope === "project-local".
  projectPath?: string;
  extensionId: string;
  approval: ApprovalRecord;
  // Synthetic rootId so the IPC layer can target stale records with the same
  // `{ rootId, extensionId }` shape used for live roots. Stale records have no
  // live root; we mint a stable id from scope so the frontend can call
  // `forgetStale({ rootId, extensionId })` without a separate API.
  rootId: string;
}

// Synthetic rootId for global stale records. Live global roots (bundled,
// user-global) have their own rootIds supplied by their producer; this is only
// used for stale records that have no matching live root.
export const STALE_GLOBAL_ROOT_ID = "global";

type ActivationSessionMap = Map<string, ExtensionActivationSession>;

const PROJECT_LOCAL_ROOT_PREFIX = "project-local:";

export function staleProjectLocalRootId(projectPath: string): string {
  return `${PROJECT_LOCAL_ROOT_PREFIX}${projectPath}`;
}

function projectPathFromProjectLocalRoot(root: ExtensionRootDescriptor): string {
  if (root.rootId.startsWith(PROJECT_LOCAL_ROOT_PREFIX)) {
    return root.rootId.slice(PROJECT_LOCAL_ROOT_PREFIX.length);
  }
  return root.path.replace(/[/\\]\.mux[/\\]extensions$/u, "");
}

export interface RegistrySnapshot {
  generatedAt: number;
  roots: RootDiscoveryResult[];
  // Capability Path output: the resolved, post-conflict, permission-gated
  // contributions. Consumers MUST read this through getContributions() so the
  // Inspection Path's cache fallback never bleeds into capability decisions.
  availableContributions: AvailableContribution[];
  resolverDiagnostics: ExtensionDiagnostic[];
  // Inspection Path payload: per-contribution availability + reasons across
  // every root, even ones the Capability Path filtered out.
  descriptors: InspectionDescriptor[];
  permissions: Record<string, CalculatePermissionsResult>;
  staleRecords: StaleRecord[];
}

export type DiscoverFn = (
  input: DiscoverExtensionsInput
) => DiscoverySnapshot | Promise<DiscoverySnapshot>;

export type RootsFn = () =>
  | readonly ExtensionRootDescriptor[]
  | Promise<readonly ExtensionRootDescriptor[]>;

export type StateFilePathsFn = () => readonly string[] | Promise<readonly string[]>;

export interface ExtensionRegistryOptions {
  /** Enumerates the active Extension Roots for this reload. */
  roots: RootsFn;
  globalState: GlobalExtensionStateService;
  projectState: ProjectExtensionStateService;
  /** Optional Snapshot Cache used for cold-start hydration of the Inspection Path. */
  snapshotCache?: SnapshotCacheService;
  /**
   * Returns the on-disk paths whose fingerprints control snapshot-cache validity.
   * Required when `snapshotCache` is set.
   */
  stateFilePaths?: StateFilePathsFn;
  perRootTimeoutMs?: number;
  perFileTimeoutMs?: number;
  now?: () => number;
  /** Override discovery for tests; defaults to the production `discoverExtensions`. */
  discoverFn?: DiscoverFn;
}

interface PreloadedState {
  globalState: NormalizedGlobalExtensionState;
  projectStates: Map<string, NormalizedProjectExtensionState>;
  inspectableProjectRootIds: Set<string>;
  rootIdToProjectPath: Map<string, string>;
  stateDiagnosticsByRootId: Map<string, ExtensionDiagnostic[]>;
  stateLookup: DiscoveryStateLookup;
}

// Owns the live Extension Snapshot. The Capability Path (`getContributions`)
// reads only from `liveSnapshot`, never from any cache; the Inspection Path
// (`getDescriptors`) may fall back to a cached snapshot during cold start so
// the Settings UI can render before the first live discovery completes.
//
// Concurrency:
// - Mutators serialize through `enqueue`; in-process callers see snapshot
//   replacement as a single atomic ref assignment.
// - Across processes, last-writer-wins is delivered by the underlying state
//   services' atomic temp-rename writes; the Registry does not lock.
export class ExtensionRegistry {
  private liveSnapshot: RegistrySnapshot | null = null;
  private cachedSnapshot: RegistrySnapshot | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private activationSessions: ActivationSessionMap = new Map();
  private readonly emitter = new EventEmitter();

  constructor(private readonly options: ExtensionRegistryOptions) {}

  onChanged(callback: () => void): () => void {
    this.emitter.on("changed", callback);
    return () => {
      this.emitter.off("changed", callback);
    };
  }

  dispose(): void {
    this.disposeActivationSessions();
    this.emitter.removeAllListeners();
  }

  getSnapshot(): RegistrySnapshot | null {
    return this.liveSnapshot;
  }

  getCachedSnapshot(): RegistrySnapshot | null {
    return this.cachedSnapshot;
  }

  // Capability Path: returns post-conflict, permission-gated contributions
  // from the live snapshot only. Returns [] before the first live discovery
  // even if a cached snapshot is available.
  getContributions(type: string): AvailableContribution[] {
    if (!this.liveSnapshot) return [];
    return this.liveSnapshot.availableContributions.filter((c) => c.type === type);
  }

  // Inspection Path: live first; cache fallback during cold start. Includes
  // unavailable contributions with reasons so the Settings UI can explain
  // why a contribution is not active.
  getDescriptors(type: string): InspectionDescriptor[] {
    const snap = this.liveSnapshot ?? this.cachedSnapshot;
    if (!snap) return [];
    return snap.descriptors.filter((d) => d.type === type);
  }

  // Capability Path resolved skill sources: returns absolute body paths plus
  // the metadata `agentSkillsService` needs to surface extension-provided
  // skills in the slash menu. Drops skills whose contribution is unavailable
  // (so the agentSkills service never sees a permission-gated skill) and
  // skills with descriptor shapes that don't satisfy the resolver — keeping
  // the merge into the host skill registry resilient to authoring errors.
  getSkillSources(projectPath?: string): ExtensionSkillSource[] {
    if (!this.liveSnapshot) return [];
    const available = new Set(
      this.liveSnapshot.availableContributions
        .filter((c) => c.type === "skills")
        .map((c) => `${c.rootId}\0${c.extensionId}\0${c.id}`)
    );
    const projectLocalSkillIds = new Set<string>();
    const projectLocalExtensionIds = new Set<string>();
    if (projectPath) {
      for (const root of this.liveSnapshot.roots) {
        if (
          root.kind !== "project-local" ||
          projectPathFromProjectLocalRoot(root) !== projectPath
        ) {
          continue;
        }
        for (const ext of root.extensions) {
          if (
            ext.contributions.some(
              (contribution) =>
                contribution.type === "skills" &&
                available.has(`${ext.rootId}\0${ext.extensionId}\0${contribution.id}`)
            )
          ) {
            // Extension Name shadowing is project-scoped: hide the lower-precedence
            // global extension only while resolving skills for this project.
            projectLocalExtensionIds.add(ext.extensionId);
            for (const contribution of ext.contributions) {
              if (
                contribution.type === "skills" &&
                available.has(`${ext.rootId}\0${ext.extensionId}\0${contribution.id}`)
              ) {
                projectLocalSkillIds.add(contribution.id);
              }
            }
          }
        }
      }
    }
    const sources: ExtensionSkillSource[] = [];
    for (const root of this.liveSnapshot.roots) {
      if (root.kind === "project-local" && projectPathFromProjectLocalRoot(root) !== projectPath) {
        continue;
      }
      const rootShadowedByProjectLocal = root.kind !== "project-local";
      for (const ext of root.extensions) {
        for (const contribution of ext.contributions) {
          if (contribution.type !== "skills") continue;
          if (rootShadowedByProjectLocal && projectLocalExtensionIds.has(ext.extensionId)) continue;
          if (rootShadowedByProjectLocal && projectLocalSkillIds.has(contribution.id)) continue;
          if (!available.has(`${ext.rootId}\0${ext.extensionId}\0${contribution.id}`)) continue;
          if (!contribution.bodyRealPath) continue;
          const manifestContribution = ext.manifest.contributions.find(
            (c) => c.index === contribution.index && c.type === contribution.type
          );
          const descriptor = manifestContribution?.descriptor;
          if (!descriptor) continue;
          const id = typeof descriptor.id === "string" ? descriptor.id : null;
          if (!id) continue;
          const description =
            typeof descriptor.description === "string" ? descriptor.description : "";
          // Authors may set advertise:false to keep a skill invokable but
          // hidden from the advertised slash-menu index, mirroring SKILL.md
          // frontmatter semantics for project / global skills.
          const advertise = typeof descriptor.advertise === "boolean" ? descriptor.advertise : true;
          const displayName =
            typeof descriptor.displayName === "string" ? descriptor.displayName : id;
          sources.push({
            name: id,
            displayName,
            description,
            advertise,
            bodyAbsolutePath: contribution.bodyRealPath,
            extensionId: ext.extensionId,
          });
        }
      }
    }
    return sources;
  }

  getStaleRecords(): StaleRecord[] {
    const snap = this.liveSnapshot ?? this.cachedSnapshot;
    return snap?.staleRecords ?? [];
  }

  // Translate an IPC-supplied `rootId` to an `ExtensionScope`. Looks up the
  // current live snapshot first (so live roots resolve to their kind/path),
  // then falls back to stale records (which carry their own synthetic rootId).
  // Returns `null` when the rootId isn't recognized so callers can throw a
  // meaningful 404-style error.
  resolveScopeByRootId(rootId: string): ExtensionScope | null {
    const live = this.liveSnapshot ?? this.cachedSnapshot;
    const liveRoot = live?.roots.find((r) => r.rootId === rootId);
    if (liveRoot) {
      if (liveRoot.kind === "project-local") {
        return { kind: "project-local", projectPath: projectPathFromProjectLocalRoot(liveRoot) };
      }
      return { kind: "global", rootId: liveRoot.rootId, rootKind: liveRoot.kind };
    }
    const stale = (live?.staleRecords ?? []).find((s) => s.rootId === rootId);
    if (stale) {
      if (stale.scope === "project-local" && stale.projectPath) {
        return { kind: "project-local", projectPath: stale.projectPath };
      }
      return { kind: "global", rootId: stale.rootId };
    }
    return null;
  }

  async loadFromCache(): Promise<void> {
    const cache = this.options.snapshotCache;
    const pathsFn = this.options.stateFilePaths;
    if (!cache || !pathsFn) return;
    const paths = await pathsFn();
    const snap = await cache.read<RegistrySnapshot>(paths);
    if (snap) this.cachedSnapshot = snap;
  }

  async reload(): Promise<void> {
    return this.enqueue(() => this.runReload());
  }

  /**
   * Public API keeps a root-scoped shape for IPC compatibility, but the current
   * implementation performs a full coherent reload so non-target roots don't
   * retain stale enablement/approval state.
   */
  async reloadRoot(rootId: string): Promise<void> {
    return this.enqueue(() => this.runReloadRoot(rootId));
  }

  async isProjectRootTrusted(projectPath: string): Promise<boolean> {
    return this.options.projectState.isRootTrusted(projectPath);
  }

  async setProjectRootTrusted(projectPath: string, trusted: boolean): Promise<void> {
    await this.options.projectState.setRootTrusted(projectPath, trusted);
  }

  async trustRoot(projectPath: string): Promise<void> {
    return this.enqueue(async () => {
      await this.options.projectState.setRootTrusted(projectPath, true);
      await this.runReload();
    });
  }

  async untrustRoot(projectPath: string): Promise<void> {
    return this.enqueue(async () => {
      await this.options.projectState.setRootTrusted(projectPath, false);
      await this.runReload();
    });
  }

  async setEnabled(scope: ExtensionScope, extensionId: string, enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (scope.kind === "global" && scope.rootKind === "bundled") {
        await this.runReload();
        return;
      }
      if (scope.kind === "global") {
        await this.options.globalState.setEnabled(extensionId, enabled);
      } else {
        await this.options.projectState.setEnabled(scope.projectPath, extensionId, enabled);
      }
      await this.runReload();
    });
  }

  async setApproval(scope: ExtensionScope, extensionId: string): Promise<void> {
    return this.enqueue(async () => {
      // The backend is authoritative for approval material. The IPC request names
      // only the target Extension; we derive capabilities from the live manifest
      // so stale renderer state cannot approve a different capability set.
      if (!this.liveSnapshot) {
        await this.runReload();
      }
      const liveApprovalMaterial = this.lookupLiveApprovalMaterial(scope, extensionId);
      if (liveApprovalMaterial === undefined) {
        throw new Error(
          `Cannot approve capabilities for ${extensionId}: Extension is not installed in the requested scope.`
        );
      }
      const normalized: ApprovalRecord = {
        grantedPermissions: [...liveApprovalMaterial.requestedPermissions],
        requestedPermissionsHash: hashRequestedPermissions(
          liveApprovalMaterial.requestedPermissions
        ),
      };
      if (scope.kind === "global") {
        await this.options.globalState.setApproval(extensionId, normalized);
      } else {
        await this.options.projectState.setApproval(scope.projectPath, extensionId, normalized);
      }
      await this.runReload();
    });
  }

  // Reads the current snapshot to find the live manifest fields for
  // `extensionId`. Approvals require a live manifest so callers cannot
  // pre-approve capabilities for an Extension that has not been reviewed.
  private lookupLiveApprovalMaterial(
    scope: ExtensionScope,
    extensionId: string
  ):
    | {
        requestedPermissions: readonly string[];
      }
    | undefined {
    const snapshot = this.liveSnapshot;
    if (!snapshot) return undefined;
    for (const root of snapshot.roots) {
      for (const ext of root.extensions) {
        if (ext.extensionId !== extensionId) continue;
        if (scope.kind === "global") {
          if (ext.rootKind === "project-local") continue;
          if (scope.rootId && ext.rootId !== scope.rootId) continue;
        }
        if (scope.kind === "project-local") {
          if (ext.rootKind !== "project-local") continue;
          if (projectPathFromProjectLocalRoot(root) !== scope.projectPath) continue;
        }
        return {
          requestedPermissions: ext.manifest.requestedPermissions,
        };
      }
    }
    return undefined;
  }

  async removeApproval(scope: ExtensionScope, extensionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (scope.kind === "global") {
        await this.options.globalState.removeApproval(extensionId);
      } else {
        await this.options.projectState.removeApproval(scope.projectPath, extensionId);
      }
      await this.runReload();
    });
  }

  async forgetStale(scope: ExtensionScope, extensionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (scope.kind === "global") {
        await this.options.globalState.forget(extensionId);
      } else {
        await this.options.projectState.forget(scope.projectPath, extensionId);
      }
      await this.runReload();
    });
  }

  // Serialize mutations so an in-flight reload doesn't observe a partial
  // snapshot. Failures detach from the queue without poisoning subsequent ops.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async runReload(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const roots = await this.options.roots();
    const preloaded = await this.preloadState(roots);
    const discover = this.options.discoverFn ?? discoverExtensions;
    const activationSessions: ActivationSessionMap = new Map();
    let next: RegistrySnapshot;
    try {
      const discovery = await discover({
        roots,
        state: preloaded.stateLookup,
        perRootTimeoutMs: this.options.perRootTimeoutMs,
        perFileTimeoutMs: this.options.perFileTimeoutMs,
        activationSessionSink: ({ rootId, extensionId, session }) => {
          const key = activationSessionKey(rootId, extensionId);
          activationSessions.get(key)?.dispose();
          activationSessions.set(key, session);
        },
        now,
      });
      next = this.composeSnapshot(discovery, now, preloaded);
    } catch (error) {
      disposeActivationSessionMap(activationSessions);
      throw error;
    }
    this.replaceActivationSessions(next, activationSessions);
    this.liveSnapshot = next;
    await this.maybeWriteCache(next);
    this.emitter.emit("changed");
  }

  private async runReloadRoot(_rootId: string): Promise<void> {
    return this.runReload();
  }

  private async preloadState(roots: readonly ExtensionRootDescriptor[]): Promise<PreloadedState> {
    const globalResult = this.options.globalState.load();
    const globalState = globalResult.state;
    const projectStates = new Map<string, NormalizedProjectExtensionState>();
    const inspectableProjectRootIds = new Set<string>();
    const rootIdToProjectPath = new Map<string, string>();
    const stateDiagnosticsByRootId = new Map<string, ExtensionDiagnostic[]>();
    for (const root of roots) {
      if (root.kind !== "user-global") continue;
      stateDiagnosticsByRootId.set(
        root.rootId,
        globalResult.diagnostics.map((diagnostic) => ({ ...diagnostic, rootId: root.rootId }))
      );
    }
    for (const root of roots) {
      if (root.kind !== "project-local") continue;
      if (root.trusted === true) inspectableProjectRootIds.add(root.rootId);
      const projectPath = projectPathFromProjectLocalRoot(root);
      rootIdToProjectPath.set(root.rootId, projectPath);
      if (!projectStates.has(projectPath)) {
        const result = await this.options.projectState.load(projectPath);
        projectStates.set(projectPath, result.state);
        stateDiagnosticsByRootId.set(
          root.rootId,
          result.diagnostics.map((diagnostic) => ({ ...diagnostic, rootId: root.rootId }))
        );
      }
    }

    const recordFor = (ctx: DiscoveryStateLookupContext): ExtensionStateRecord | undefined => {
      if (ctx.rootKind === "project-local") {
        const projectPath = rootIdToProjectPath.get(ctx.rootId);
        if (!projectPath) return undefined;
        return projectStates.get(projectPath)?.extensions[ctx.extensionId];
      }
      if (ctx.rootKind === "bundled") return undefined;
      return globalState.extensions[ctx.extensionId];
    };

    const stateLookup: DiscoveryStateLookup = {
      isEnabled: (ctx) => recordFor(ctx)?.enabled ?? ctx.isBundled,
      getApprovalRecord: (ctx) => recordFor(ctx)?.approval,
    };

    return {
      globalState,
      projectStates,
      inspectableProjectRootIds,
      rootIdToProjectPath,
      stateDiagnosticsByRootId,
      stateLookup,
    };
  }

  private composeSnapshot(
    discovery: DiscoverySnapshot,
    now: number,
    preloaded: PreloadedState
  ): RegistrySnapshot {
    const permissions: Record<string, CalculatePermissionsResult> = {};
    const candidates: CandidateExtension[] = [];
    const descriptors: InspectionDescriptor[] = [];
    const liveExtensionKeys = new Set<string>();

    const rootsWithStateDiagnostics = discovery.roots.map((root) => {
      const diagnostics = preloaded.stateDiagnosticsByRootId.get(root.rootId) ?? [];
      if (diagnostics.length === 0) return root;
      return { ...root, diagnostics: [...root.diagnostics, ...diagnostics] };
    });
    const rootsWithActivationFallback = rootsWithStateDiagnostics.map((root) =>
      applyPreviousGoodActivations(root)
    );

    for (const root of rootsWithActivationFallback) {
      for (const ext of root.extensions) {
        liveExtensionKeys.add(staleRecordKey(root.rootId, root.kind, ext.extensionId));
        const grant = lookupApproval(ext, root.rootId, preloaded);
        const permResult = computePermissions(ext, grant);
        permissions[extensionPermissionKey(ext.rootId, ext.extensionId)] = permResult;

        const isTrusted = root.trusted;
        for (const c of ext.contributions) {
          const reasons = collectUnavailableReasons(ext, c, permResult, isTrusted);
          const permEntry = permResult.contributions.find(
            (pc) => pc.type === c.type && pc.id === c.id
          );
          descriptors.push({
            type: c.type,
            id: c.id,
            extensionId: ext.extensionId,
            rootId: ext.rootId,
            rootKind: ext.rootKind,
            available: reasons.length === 0,
            unavailableReasons: reasons,
            missingPermissions: permEntry?.missingPermissions ?? [],
          });
        }

        const allowed: CandidateContribution[] = [];
        if (!ext.activated) continue;
        for (const c of ext.contributions) {
          if (!c.activated) continue;
          const permEntry = permResult.contributions.find(
            (pc) => pc.type === c.type && pc.id === c.id
          );
          if (c.type !== "skills") continue;
          if (requiresReapproval(permResult)) continue;
          if (permEntry?.available) allowed.push({ type: c.type, id: c.id });
        }
        if (allowed.length === 0) continue;
        candidates.push({
          extensionId: ext.extensionId,
          rootId: ext.rootId,
          rootKind: ext.rootKind,
          isCore: ext.isCore,
          contributions: allowed,
        });
      }
    }

    const conflict = resolveConflicts({ candidates, now });

    // Annotate descriptors that lost a Conflict Resolver pass with the
    // "conflict" reason so the Settings UI can render the explanation
    // alongside other unavailability reasons.
    const availableContributionKeys = new Set(
      conflict.availableContributions.map((c) =>
        availableContributionKey(c.rootId, c.extensionId, c.type, c.id)
      )
    );
    const conflictByExtension = new Map<string, Set<string>>();
    for (const diag of conflict.diagnostics) {
      if (
        diag.code !== "extension.identity.conflict" &&
        diag.code !== "contribution.identity.conflict"
      ) {
        continue;
      }
      if (!diag.extensionId) continue;
      const key = `${diag.rootId ?? ""}\0${diag.extensionId}`;
      const set = conflictByExtension.get(key) ?? new Set<string>();
      const ref = diag.contributionRef;
      // For extension-identity conflicts, mark every contribution; for
      // contribution-identity conflicts, mark only the referenced one.
      set.add(ref ? `${ref.type}::${ref.id ?? ""}` : "*");
      conflictByExtension.set(key, set);
    }
    for (const d of descriptors) {
      const marks =
        conflictByExtension.get(`${d.rootId}\0${d.extensionId}`) ??
        conflictByExtension.get(`\0${d.extensionId}`);
      if (!marks) continue;
      if (
        (marks.has("*") || marks.has(`${d.type}::${d.id}`)) &&
        !availableContributionKeys.has(
          availableContributionKey(d.rootId, d.extensionId, d.type, d.id)
        )
      ) {
        if (!d.unavailableReasons.includes("conflict")) {
          d.unavailableReasons.push("conflict");
        }
        d.available = false;
      }
    }

    const staleRecords = computeStaleRecords(preloaded, liveExtensionKeys);

    return {
      generatedAt: now,
      roots: rootsWithActivationFallback,
      availableContributions: conflict.availableContributions,
      resolverDiagnostics: conflict.diagnostics,
      descriptors,
      permissions,
      staleRecords,
    };
  }

  private replaceActivationSessions(
    snapshot: RegistrySnapshot,
    discoveredSessions: ActivationSessionMap
  ): void {
    const liveKeys = activeActivationSessionKeys(snapshot);
    const nextSessions: ActivationSessionMap = new Map();

    for (const [key, session] of discoveredSessions) {
      if (liveKeys.has(key)) {
        nextSessions.set(key, session);
      } else {
        session.dispose();
      }
    }

    for (const [key, session] of this.activationSessions) {
      if (nextSessions.has(key)) {
        session.dispose();
      } else if (liveKeys.has(key)) {
        // Hot reload can keep the previous good skill body when only the new
        // declarative file failed validation. Preserve the matching sandbox too
        // so Full Activation remains explicitly owned until the extension stops.
        nextSessions.set(key, session);
      } else {
        session.dispose();
      }
    }

    this.activationSessions = nextSessions;
  }

  private disposeActivationSessions(): void {
    disposeActivationSessionMap(this.activationSessions);
    this.activationSessions = new Map();
  }

  private async maybeWriteCache(snapshot: RegistrySnapshot): Promise<void> {
    const cache = this.options.snapshotCache;
    const pathsFn = this.options.stateFilePaths;
    if (!cache || !pathsFn) return;
    try {
      const paths = await pathsFn();
      await cache.write(snapshot, paths);
    } catch (error) {
      log.warn("[extensions] Failed to write snapshot cache", { error });
    }
  }
}

function applyPreviousGoodActivations(root: RootDiscoveryResult): RootDiscoveryResult {
  return root;
}

function activeActivationSessionKeys(snapshot: RegistrySnapshot): Set<string> {
  const keys = new Set<string>();
  for (const root of snapshot.roots) {
    for (const extension of root.extensions) {
      if (!extension.activated) continue;
      keys.add(activationSessionKey(extension.rootId, extension.extensionId));
    }
  }
  return keys;
}

function activationSessionKey(rootId: string, extensionId: string): string {
  return `${rootId}\0${extensionId}`;
}

function disposeActivationSessionMap(sessions: ActivationSessionMap): void {
  for (const session of sessions.values()) {
    session.dispose();
  }
  sessions.clear();
}

function availableContributionKey(
  rootId: string,
  extensionId: string,
  type: string,
  id: string
): string {
  return `${rootId}\0${extensionId}\0${type}\0${id}`;
}

function lookupApproval(
  ext: DiscoveredExtension,
  rootId: string,
  preloaded: PreloadedState
): ApprovalRecord | undefined {
  if (ext.rootKind === "bundled") {
    return undefined;
  }
  if (ext.rootKind === "project-local") {
    const projectPath = preloaded.rootIdToProjectPath.get(rootId);
    if (!projectPath) return undefined;
    return preloaded.projectStates.get(projectPath)?.extensions[ext.extensionId]?.approval;
  }
  return preloaded.globalState.extensions[ext.extensionId]?.approval;
}

// Bundled Extension approvals are policy-derived and recomputed on every reload;
// they are never persisted.
function synthesizePolicyApproval(ext: DiscoveredExtension): ApprovalRecord {
  return {
    grantedPermissions: [...ext.manifest.requestedPermissions],
    requestedPermissionsHash: hashRequestedPermissions(ext.manifest.requestedPermissions),
  };
}

function computePermissions(
  ext: DiscoveredExtension,
  approval: ApprovalRecord | undefined
): CalculatePermissionsResult {
  const requirements: ContributionPermissionRequirement[] = ext.manifest.contributions.map((c) => ({
    type: c.type,
    id: c.id,
    registrationPermission:
      CONTRIBUTION_TYPE_REGISTRATION_PERMISSIONS[c.type] ?? `${c.type}.register`,
  }));
  const effectiveApproval =
    approval ?? (ext.rootKind === "bundled" ? synthesizePolicyApproval(ext) : undefined);
  return calculatePermissions({
    manifest: {
      requestedPermissions: ext.manifest.requestedPermissions,
      contributions: requirements,
    },
    approvalRecord: effectiveApproval,
  });
}

function collectUnavailableReasons(
  ext: DiscoveredExtension,
  contribution: DiscoveredContribution,
  permResult: CalculatePermissionsResult,
  rootTrusted: boolean
): UnavailableReason[] {
  const reasons: UnavailableReason[] = [];
  if (!rootTrusted) reasons.push("untrusted-root");
  if (!ext.enabled) reasons.push("disabled");
  if (!ext.granted) reasons.push("ungranted");
  if (contribution.type !== "skills") reasons.push("inspection-only");
  const permEntry = permResult.contributions.find(
    (pc) => pc.type === contribution.type && pc.id === contribution.id
  );
  if (requiresReapproval(permResult)) reasons.push("pending-reapproval");
  if (permEntry && !permEntry.available) reasons.push("missing-permissions");
  if (ext.enabled && ext.granted && rootTrusted) {
    if (!ext.activated) reasons.push("body-failed");
    else if (!contribution.activated) reasons.push("not-activated");
  }
  return reasons;
}

function staleRecordKey(rootId: string, rootKind: RootKind, extensionId: string): string {
  if (rootKind === "project-local") return `${rootId}\0${extensionId}`;
  if (rootKind === "user-global") return `${STALE_GLOBAL_ROOT_ID}\0${extensionId}`;
  return `bundled\0${extensionId}`;
}

function computeStaleRecords(
  preloaded: PreloadedState,
  liveExtensionKeys: ReadonlySet<string>
): StaleRecord[] {
  const stale: StaleRecord[] = [];
  for (const [extensionId, record] of Object.entries(preloaded.globalState.extensions)) {
    if (
      record.approval &&
      !liveExtensionKeys.has(staleRecordKey(STALE_GLOBAL_ROOT_ID, "user-global", extensionId))
    ) {
      stale.push({
        scope: "global",
        extensionId,
        approval: record.approval,
        rootId: STALE_GLOBAL_ROOT_ID,
      });
    }
  }
  for (const [projectPath, projectState] of preloaded.projectStates) {
    const rootId = staleProjectLocalRootId(projectPath);
    if (!preloaded.inspectableProjectRootIds.has(rootId)) continue;
    for (const [extensionId, record] of Object.entries(projectState.extensions)) {
      if (
        record.approval &&
        !liveExtensionKeys.has(staleRecordKey(rootId, "project-local", extensionId))
      ) {
        stale.push({
          scope: "project-local",
          projectPath,
          extensionId,
          approval: record.approval,
          rootId,
        });
      }
    }
  }
  return stale;
}
