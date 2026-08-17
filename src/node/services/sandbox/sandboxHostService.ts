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
}

export class SandboxMount {
  /** Set by code_execution after registering the mux.* tool bridge, so a
   * reused persistent runtime is not re-registered on every call. */
  public bridgeRegistered = false;

  private readonly hostEventQueue: unknown[] = [];
  private disposed = false;

  constructor(
    public readonly runtime: IJSRuntime,
    public readonly lifetime: SandboxMountLifetime,
    public readonly grants: CapabilityGrants,
    public readonly scopeKey?: string,
    /** Bound by the host service; persists a vars snapshot via the journal kit. */
    private readonly persistSnapshot?: (varsJson: string) => Promise<void>
  ) {}

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
    assert(result.success, `snapshotVars failed: ${result.error}`);
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
    assert(result.success, `restoreVars failed: ${result.error}`);
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

export class SandboxHostService {
  private readonly persistentMounts = new Map<string, SandboxMount>();
  private readonly journals = new Map<string, DurableEventJournal>();

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
    const sessionDir = options.sessionDir;
    assert(scopeKey, "persistent mounts require a scopeKey");
    assert(sessionDir, "persistent mounts require a sessionDir");

    const existing = this.persistentMounts.get(scopeKey);
    if (existing && !existing.isDisposed) {
      return existing;
    }

    const journal = this.journalFor(scopeKey, sessionDir);
    const runtime = await options.runtimeFactory.create();
    const mount = new SandboxMount(runtime, "persistent", grants, scopeKey, async (varsJson) => {
      const { ref, size } = await journal.blobs.put(varsJson);
      await journal.append({
        workspaceId: scopeKey,
        kind: "sandbox-vars-snapshot",
        data: { scopeKey, blobHash: ref, size },
      });
    });

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
    const mount = this.persistentMounts.get(scopeKey);
    if (!mount || mount.isDisposed) return;
    await mount.persistVars();
  }

  /**
   * Dispose a scope's persistent mount (workspace archive/reset). Snapshots
   * best-effort first so state survives un-archive and restarts.
   */
  async disposeScope(scopeKey: string): Promise<void> {
    const mount = this.persistentMounts.get(scopeKey);
    this.persistentMounts.delete(scopeKey);
    this.journals.delete(scopeKey);
    if (!mount || mount.isDisposed) return;
    try {
      await mount.persistVars();
    } catch (error) {
      // Never let a snapshot failure block archive/reset.
      log.warn(`SandboxHostService: vars snapshot failed for scope ${scopeKey}`, { error });
    }
    mount.dispose();
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
    assert(init.success, `vars init failed: ${init.error}`);

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
