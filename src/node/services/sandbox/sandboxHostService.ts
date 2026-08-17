/**
 * Sandbox Host Service (substrate 3 of the shared agent foundation).
 *
 * One home for QuickJS guest hosting with two mount lifetimes:
 * - `ephemeral`: per-call, behaviorally identical to the pre-service
 *   code_execution flow (create → eval → dispose).
 * - `persistent`: per-workspace-session; the runtime survives across
 *   code_execution calls and turns, is disposed on workspace archive/reset,
 *   and exposes a guest-visible `vars` namespace whose JSON-serializable
 *   contents the host snapshots via the journal kit (contract: data only —
 *   functions/closures are not captured).
 *
 * Persistent mounts also get:
 * - an async capability bridge (runtime.registerPromiseFunction) — used by
 *   Track 2 for `mux.task({background:true})`-style handles;
 * - host→guest event delivery: a queue drained from the guest via the global
 *   `drainHostEvents()` (queue + drain model, no interrupts).
 *
 * WorkflowRunner intentionally keeps constructing runtimes through
 * IJSRuntimeFactory directly: its replay-safety must not regress, and it
 * already consumes the same abstract interface (migration note per handoff).
 */

import assert from "node:assert";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import { resolveCapabilityGrants, type CapabilityGrants } from "@/common/types/capabilityGrants";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { log } from "@/node/services/log";

export type SandboxMountLifetime = "ephemeral" | "persistent";

export interface AcquireMountOptions {
  lifetime: SandboxMountLifetime;
  /**
   * Factory for creating the guest runtime. Caller-provided (rather than a
   * service default) so this module never statically pulls the QuickJS WASM
   * stack — toolAssembly lazy-loads PTC deliberately, and archive/reset
   * disposal must be importable from startup paths.
   */
  runtimeFactory: IJSRuntimeFactory;
  /** Stable scope identity (workspaceId). Required for persistent mounts. */
  scopeKey?: string;
  /** Session dir for vars snapshots (journal + blobs). Required for persistent mounts. */
  sessionDir?: string;
  /** Capability grants for this mount. Defaults to session-scope grants. */
  grants?: CapabilityGrants;
  /**
   * Identity of the effective bridge configuration (e.g. sorted bridgeable
   * tool names). Persistent guests can save bridge function references in
   * globals (`globalThis.saved = mux.bash`) that survive re-registration, so
   * when the effective bridge NARROWS the mount must be rebuilt — destroying
   * the runtime is the only reliable way to revoke saved closures. Vars
   * survive via snapshot/restore.
   */
  bridgeKey?: string;
}

export class SandboxMount {
  private readonly hostEventQueue: unknown[] = [];
  private disposed = false;

  constructor(
    public readonly runtime: IJSRuntime,
    public readonly lifetime: SandboxMountLifetime,
    public readonly grants: CapabilityGrants,
    public readonly scopeKey?: string,
    /** Bound by the host service; persists a vars snapshot via the journal kit. */
    private readonly persistSnapshot?: (varsJson: string) => Promise<void>,
    /** Persistent mounts share the host's per-scope mutex so exclusive() also
     * serializes against scope disposal; ephemeral mounts get their own. */
    private readonly mutex: AsyncMutex = new AsyncMutex(),
    /** Effective bridge configuration identity; see AcquireMountOptions. */
    public readonly bridgeKey?: string
  ) {
    // Late capability settlements (fire-and-forget guest code) must not
    // re-enter the shared runtime while a later eval holds it: route their
    // pending-job execution through the same exclusive lock.
    runtime.setPendingJobGate((run) => {
      this.exclusive(async () => {
        run();
        // The continuation may have mutated vars AFTER the originating call's
        // snapshot: persist so a restart cannot resurrect older state (memory
        // and disk must agree — mirrors code_execution's post-eval path,
        // including dispose-on-failure so an unsnapshottable state cannot
        // linger).
        if (!this.disposed && this.lifetime === "persistent" && this.grants.vars) {
          try {
            await this.persistVars();
          } catch (error) {
            log.warn(
              "SandboxMount: vars snapshot after gated continuation failed; disposing mount",
              { error }
            );
            this.dispose();
          }
        }
      }).catch((error: unknown) => {
        log.warn("SandboxMount: gated pending-job run failed", { error });
      });
    });
  }

  /**
   * Run `fn` with exclusive access to this mount's runtime. Concurrent
   * code_execution calls can share one persistent mount, but eval() mutates
   * runtime-wide state (abort controller, tool-call attribution, handlers),
   * so evaluation + vars persistence must be serialized per runtime.
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await using _lock = await this.mutex.acquire();
    return await fn();
  }

  /** Queue a host event for the guest. Guest drains via drainHostEvents(). */
  postHostEvent(event: unknown): void {
    this.assertNotDisposed("postHostEvent");
    assert(this.grants.hostEvents, "postHostEvent requires the hostEvents grant");
    this.hostEventQueue.push(event);
  }

  /** Drain the queued host events (called from the guest bridge function). */
  drainHostEvents(): unknown[] {
    const events = this.hostEventQueue.splice(0, this.hostEventQueue.length);
    return events;
  }

  /**
   * Snapshot the guest `vars` namespace as JSON text. Crashes fast (eval
   * error) if vars contains non-serializable values like cycles — the
   * contract is data only.
   */
  async snapshotVars(): Promise<string> {
    this.assertNotDisposed("snapshotVars");
    assert(this.grants.vars, "snapshotVars requires the vars grant");
    const result = await this.runtime.eval("return JSON.stringify(globalThis.vars ?? {});");
    assert(result.success, `snapshotVars failed: ${result.error ?? "unknown error"}`);
    assert(typeof result.result === "string", "snapshotVars: expected JSON string result");
    return result.result;
  }

  /** Replace the guest `vars` namespace from JSON text (snapshot restore). */
  async restoreVars(varsJson: string): Promise<void> {
    this.assertNotDisposed("restoreVars");
    assert(this.grants.vars, "restoreVars requires the vars grant");
    // Parse host-side first: crash-fast on corrupted snapshots instead of
    // injecting garbage into the guest.
    JSON.parse(varsJson);
    const literal = JSON.stringify(varsJson);
    const result = await this.runtime.eval(
      `globalThis.vars = JSON.parse(${literal}); return true;`
    );
    assert(result.success, `restoreVars failed: ${result.error ?? "unknown error"}`);
  }

  /** Snapshot vars and persist through the journal kit (persistent mounts). */
  async persistVars(): Promise<void> {
    this.assertNotDisposed("persistVars");
    assert(
      this.persistSnapshot,
      "persistVars is only available on persistent mounts with a session dir"
    );
    const varsJson = await this.snapshotVars();
    await this.persistSnapshot(varsJson);
  }

  /** Per-call release: disposes ephemeral mounts, keeps persistent ones alive. */
  release(): void {
    if (this.lifetime === "ephemeral") {
      this.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runtime.dispose();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private assertNotDisposed(method: string): void {
    assert(!this.disposed, `SandboxMount.${method} called after dispose`);
  }
}

/** Stable identity for a grant set, used to detect grant changes on reuse. */
function grantsKey(grants: CapabilityGrants): string {
  const allow = grants.bridgeTools.allow;
  const tools = allow === "all" ? "all" : [...allow].sort().join(",");
  return `${grants.version}|${tools}|${grants.vars}|${grants.hostEvents}`;
}

export class SandboxHostService {
  private readonly persistentMounts = new Map<string, SandboxMount>();
  private readonly journals = new Map<string, DurableEventJournal>();
  /** Per-scope mutex serializing acquisition, exclusive runs, and disposal.
   * Kept for the process lifetime (bounded by workspace count). */
  private readonly scopeLocks = new Map<string, AsyncMutex>();

  private lockFor(scopeKey: string): AsyncMutex {
    let lock = this.scopeLocks.get(scopeKey);
    if (!lock) {
      lock = new AsyncMutex();
      this.scopeLocks.set(scopeKey, lock);
    }
    return lock;
  }

  /**
   * Acquire a mount. Ephemeral mounts are always fresh; persistent mounts are
   * reused per scopeKey and restored from the latest vars snapshot when
   * (re)created — this is the crash/restart recovery path.
   */
  async acquireMount(options: AcquireMountOptions): Promise<SandboxMount> {
    const grants = options.grants ?? resolveCapabilityGrants({ scope: "session" });

    if (options.lifetime === "ephemeral") {
      const runtime = await options.runtimeFactory.create();
      return new SandboxMount(runtime, "ephemeral", grants);
    }

    const scopeKey = options.scopeKey;
    assert(scopeKey, "persistent mounts require a scopeKey");

    // Serialize per scope: concurrent first acquisitions must not both create
    // runtimes (the map is only populated after several awaits), and
    // acquisition must not interleave with disposal or an exclusive run.
    const lock = this.lockFor(scopeKey);
    await using _guard = await lock.acquire();
    return await this.acquirePersistentMountLocked(options, grants);
  }

  /**
   * Run `fn` with a persistent mount while HOLDING the scope lock from
   * acquisition through execution. acquireMount + a later mount.exclusive()
   * leaves an unprotected gap where a concurrent grants/bridge change or
   * scope disposal can dispose the returned mount; this API closes that gap —
   * code_execution's register→eval→persist sequence runs entirely under one
   * lease. `fn` must NOT call mount.exclusive() (same non-reentrant lock).
   */
  async withPersistentMount<T>(
    options: AcquireMountOptions,
    fn: (mount: SandboxMount) => Promise<T>
  ): Promise<T> {
    assert(options.lifetime === "persistent", "withPersistentMount requires lifetime=persistent");
    const scopeKey = options.scopeKey;
    assert(scopeKey, "persistent mounts require a scopeKey");
    const grants = options.grants ?? resolveCapabilityGrants({ scope: "session" });

    const lock = this.lockFor(scopeKey);
    await using _guard = await lock.acquire();
    const mount = await this.acquirePersistentMountLocked(options, grants);
    return await fn(mount);
  }

  /** Get-or-create the persistent mount for a scope. Caller must hold the scope lock. */
  private async acquirePersistentMountLocked(
    options: AcquireMountOptions,
    grants: CapabilityGrants
  ): Promise<SandboxMount> {
    const scopeKey = options.scopeKey;
    const sessionDir = options.sessionDir;
    assert(scopeKey, "persistent mounts require a scopeKey");
    assert(sessionDir, "persistent mounts require a sessionDir");
    const lock = this.lockFor(scopeKey);

    const existing = this.persistentMounts.get(scopeKey);
    if (existing && !existing.isDisposed) {
      if (
        grantsKey(existing.grants) === grantsKey(grants) &&
        existing.bridgeKey === options.bridgeKey
      ) {
        return existing;
      }
      // Effective grants OR bridge configuration changed between requests
      // (e.g. policy narrowed): a mount must never outlive its capability
      // boundary, and rebuilding the runtime is the only way to revoke bridge
      // function references the guest saved in globals. Snapshot under the
      // OLD grants, dispose, and rebuild below.
      await this.disposeScopeLocked(scopeKey);
    }

    const journal = this.journalFor(scopeKey, sessionDir);
    const runtime = await options.runtimeFactory.create();
    const mount = new SandboxMount(
      runtime,
      "persistent",
      grants,
      scopeKey,
      async (varsJson) => {
        const { ref, size } = await journal.blobs.put(varsJson);
        await journal.append({
          workspaceId: scopeKey,
          kind: "sandbox-vars-snapshot",
          data: { scopeKey, blobHash: ref, size },
        });
      },
      lock,
      options.bridgeKey
    );

    if (grants.vars) {
      await this.initializeVars(mount, journal, scopeKey);
    }
    if (grants.hostEvents) {
      // Queue + drain: the guest polls for host events (task completions,
      // lifecycle notifications). Must be a SYNC bridge function: guests call
      // it from continuations after awaiting capability promises, where
      // asyncified functions cannot suspend.
      runtime.registerSyncFunction("drainHostEvents", () => mount.drainHostEvents());
    }

    this.persistentMounts.set(scopeKey, mount);
    return mount;
  }

  /** Persist the current vars snapshot for a live persistent scope. */
  async snapshotScope(scopeKey: string): Promise<void> {
    await using _guard = await this.lockFor(scopeKey).acquire();
    const mount = this.persistentMounts.get(scopeKey);
    if (!mount || mount.isDisposed) return;
    await mount.persistVars();
  }

  /**
   * Dispose a scope's persistent mount (workspace archive/reset). Snapshots
   * best-effort first so state survives un-archive and restarts.
   */
  async disposeScope(scopeKey: string): Promise<void> {
    // The scope lock also backs mount.exclusive(), so disposal waits for any
    // in-flight evaluation instead of pulling the runtime out from under it.
    await using _guard = await this.lockFor(scopeKey).acquire();
    await this.disposeScopeLocked(scopeKey);
  }

  /** Dispose logic without taking the scope lock: caller must hold it. */
  private async disposeScopeLocked(scopeKey: string): Promise<void> {
    const mount = this.persistentMounts.get(scopeKey);
    this.persistentMounts.delete(scopeKey);
    this.journals.delete(scopeKey);
    if (!mount || mount.isDisposed) return;
    if (mount.grants.vars) {
      try {
        await mount.persistVars();
      } catch (error) {
        // Never let a snapshot failure block archive/reset.
        log.warn(`SandboxHostService: vars snapshot failed for scope ${scopeKey}`, { error });
      }
    }
    mount.dispose();
  }

  /**
   * Drop a scope entirely (workspace removal): dispose the runtime and forget
   * journals WITHOUT any disk writes. The caller is deleting the session
   * directory — a snapshot here would recreate it, and an in-flight exclusive
   * run must finish first (the lock serializes) so it cannot persist into the
   * deleted directory afterwards.
   */
  async dropScope(scopeKey: string): Promise<void> {
    await using _guard = await this.lockFor(scopeKey).acquire();
    const mount = this.persistentMounts.get(scopeKey);
    this.persistentMounts.delete(scopeKey);
    this.journals.delete(scopeKey);
    // The scope lock stays in the map (see scopeLocks doc): deleting it while
    // waiters hold references could let two locks govern the same scope.
    if (mount && !mount.isDisposed) {
      mount.dispose();
    }
  }

  /**
   * Discard a scope's sandbox state (context reset): dispose the mount
   * WITHOUT snapshotting current vars, and supersede any earlier snapshot
   * with an empty one so the next mount starts fresh instead of restoring
   * pre-reset state. Rotation-by-append keeps the journal append-only.
   */
  async discardScope(scopeKey: string, sessionDir: string): Promise<void> {
    await using _guard = await this.lockFor(scopeKey).acquire();
    const mount = this.persistentMounts.get(scopeKey);
    this.persistentMounts.delete(scopeKey);
    const journal = this.journals.get(scopeKey) ?? new DurableEventJournal(sessionDir);
    this.journals.delete(scopeKey);
    if (mount && !mount.isDisposed) {
      mount.dispose();
    }
    try {
      // Only write the empty snapshot when there is prior state to supersede;
      // otherwise a reset in a sandbox-less workspace would create journal
      // files for nothing.
      const events = await journal.read();
      const hasSnapshot = events.some(
        (event) => event.kind === "sandbox-vars-snapshot" && event.data.scopeKey === scopeKey
      );
      if (!hasSnapshot) return;
      const { ref, size } = await journal.blobs.put("{}");
      await journal.append({
        workspaceId: scopeKey,
        kind: "sandbox-vars-snapshot",
        data: { scopeKey, blobHash: ref, size },
      });
    } catch (error) {
      // Never let discard bookkeeping block a context reset.
      log.warn(`SandboxHostService: vars discard failed for scope ${scopeKey}`, { error });
    }
  }

  /** True when a live persistent mount exists for the scope. */
  hasScope(scopeKey: string): boolean {
    const mount = this.persistentMounts.get(scopeKey);
    return mount !== undefined && !mount.isDisposed;
  }

  disposeAll(): void {
    for (const mount of this.persistentMounts.values()) {
      mount.dispose();
    }
    this.persistentMounts.clear();
    this.journals.clear();
  }

  private journalFor(scopeKey: string, sessionDir: string): DurableEventJournal {
    let journal = this.journals.get(scopeKey);
    if (!journal) {
      journal = new DurableEventJournal(sessionDir);
      this.journals.set(scopeKey, journal);
    }
    return journal;
  }

  /** Set up `vars` and restore the latest snapshot if one exists (self-heal:
   * a missing/corrupt snapshot starts empty instead of failing the mount). */
  private async initializeVars(
    mount: SandboxMount,
    journal: DurableEventJournal,
    scopeKey: string
  ): Promise<void> {
    const init = await mount.runtime.eval("globalThis.vars = {}; return true;");
    assert(init.success, `vars init failed: ${init.error ?? "unknown error"}`);

    const events = await journal.read();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.kind !== "sandbox-vars-snapshot" || event.data.scopeKey !== scopeKey) {
        continue;
      }
      const varsJson = await journal.blobs.getText(event.data.blobHash);
      if (varsJson === null) {
        log.warn(
          `SandboxHostService: latest vars snapshot blob missing/corrupt for ${scopeKey}; starting empty`
        );
        return;
      }
      try {
        await mount.restoreVars(varsJson);
      } catch (error) {
        log.warn(`SandboxHostService: vars restore failed for ${scopeKey}; starting empty`, {
          error,
        });
      }
      return;
    }
  }
}

/**
 * Process-wide host singleton (mirrors eventSpine). Production consumers:
 * code_execution persistent mounts (opt-in) and workspace archive/reset
 * disposal. Tests construct their own instances.
 */
export const sandboxHostService = new SandboxHostService();
