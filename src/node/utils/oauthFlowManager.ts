import type http from "node:http";
import type { Result } from "@/common/types/result";
import { Err } from "@/common/types/result";
import { closeServer } from "@/node/utils/oauthUtils";
import { log } from "@/node/services/log";

/**
 * Shared desktop OAuth flow lifecycle manager.
 *
 * Four OAuth services (Gateway, Governor, Codex, MCP) track in-flight desktop
 * flows with an identical `Map<string, DesktopFlow>` + `waitFor`/`cancel`/
 * `finish`/`shutdownAll` pattern. This class extracts that shared lifecycle
 * so each service can delegate flow bookkeeping here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthFlowEntry {
  /** The loopback HTTP server (null for device-code flows). */
  server: http.Server | null;
  /** Deferred that resolves with the final flow result. */
  resultDeferred: {
    promise: Promise<Result<void, string>>;
    resolve: (value: Result<void, string>) => void;
  };
  /** Handle for the server-side timeout (set at registration time by the caller). */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

interface CompletedOAuthFlowEntry {
  result: Result<void, string>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_COMPLETED_FLOW_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class OAuthFlowManager {
  private readonly flows = new Map<string, OAuthFlowEntry>();
  private readonly completed = new Map<string, CompletedOAuthFlowEntry>();

  constructor(private readonly completedFlowTtlMs = DEFAULT_COMPLETED_FLOW_TTL_MS) {}

  /** Register a new in-flight flow. */
  register(flowId: string, entry: OAuthFlowEntry): void {
    // If a flow ID is re-used before the completed-flow TTL expires, ensure the
    // old cleanup timer can't delete the new result.
    this.clearCompleted(flowId);
    this.flows.set(flowId, entry);
  }

  private clearCompleted(flowId: string): void {
    const existing = this.completed.get(flowId);
    if (!existing) return;

    if (existing.cleanupTimeout !== null) {
      clearTimeout(existing.cleanupTimeout);
    }

    this.completed.delete(flowId);
  }

  /** Get a flow entry by ID, or undefined if not found. */
  get(flowId: string): OAuthFlowEntry | undefined {
    return this.flows.get(flowId);
  }

  /** Check whether a flow exists. */
  has(flowId: string): boolean {
    return this.flows.has(flowId);
  }

  /**
   * Wait for a flow to complete with a caller-facing timeout race.
   *
   * Mirrors the `waitForDesktopFlow` pattern shared across all four services:
   * - Creates a local timeout promise for this wait call only.
   * - Races that local timeout against `flow.resultDeferred.promise`.
   * - Registration-time timeout remains on `flow.timeoutHandle` and is cleared in `finish`.
   * - On any error result (caller timeout or flow error), calls `finish` for shared cleanup.
   */
  async waitFor(flowId: string, timeoutMs: number): Promise<Result<void, string>> {
    const flow = this.flows.get(flowId);
    if (!flow) {
      const completed = this.completed.get(flowId);
      if (completed) {
        return completed.result;
      }

      return Err("OAuth flow not found");
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<void, string>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(Err("Timed out waiting for OAuth callback"));
      }, timeoutMs);
    });

    const result = await Promise.race([flow.resultDeferred.promise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      // Ensure listener is closed on timeout/errors.
      void this.finish(flowId, result);
    }

    return result;
  }

  /**
   * Cancel a flow — resolves the deferred with an error and cleans up.
   *
   * Mirrors the `cancelDesktopFlow` pattern.
   */
  async cancel(flowId: string): Promise<void> {
    const flow = this.flows.get(flowId);
    if (!flow) return;

    await this.finish(flowId, Err("OAuth flow cancelled"));
  }

  /**
   * Finish a flow: resolve the deferred, clear the timeout, close the server,
   * and remove the entry from the map.
   *
   * Idempotent — no-op if the flow was already removed. Mirrors the
   * `finishDesktopFlow` pattern.
   */
  async finish(flowId: string, result: Result<void, string>): Promise<void> {
    const flow = this.flows.get(flowId);
    if (!flow) return;

    // Remove from map first to make re-entrant calls no-ops.
    this.flows.delete(flowId);

    if (flow.timeoutHandle !== null) {
      clearTimeout(flow.timeoutHandle);
    }

    // Preserve the final result briefly so late waiters can still retrieve it.
    //
    // Old per-service DesktopFlow implementations kept completed flows around for
    // ~60s (cleanupTimeout) to avoid a race where the OAuth callback finishes
    // before the frontend begins `waitFor`-ing.
    this.clearCompleted(flowId);
    const cleanupTimeout = setTimeout(() => {
      this.completed.delete(flowId);
    }, this.completedFlowTtlMs);

    // Don't keep the node process alive just to delete old completed entries.
    if (typeof cleanupTimeout !== "number") {
      cleanupTimeout.unref?.();
    }

    this.completed.set(flowId, { result, cleanupTimeout });

    try {
      flow.resultDeferred.resolve(result);

      if (flow.server) {
        // Stop accepting new connections.
        await closeServer(flow.server);
      }
    } catch (error) {
      log.debug("Failed to close OAuth callback listener:", error);
    }
  }

  /**
   * Shut down all active flows — resolves each with an error.
   *
   * Mirrors the `dispose` pattern where services iterate all flows
   * and finish them with `Err("App shutting down")`.
   */
  async shutdownAll(): Promise<void> {
    const flowIds = [...this.flows.keys()];
    await Promise.all(flowIds.map((id) => this.finish(id, Err("App shutting down"))));
  }
}
