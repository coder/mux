/**
 * SSH Connection Pool
 *
 * Manages SSH connections with:
 * - Deterministic ControlPath generation for connection multiplexing
 * - Health tracking to avoid re-probing known-healthy connections
 * - Exponential backoff to prevent thundering herd on failures
 * - Singleflighting to coalesce concurrent connection attempts
 *
 * Design:
 * - acquireConnection() ensures a healthy connection before proceeding
 * - Known-healthy connections return immediately (no probe)
 * - Failed connections enter backoff before retry
 * - Concurrent calls to same host share a single probe
 */

import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { log } from "@/node/services/log";

/**
 * SSH Runtime Configuration (defined here to avoid circular deps with SSHRuntime)
 */
export interface SSHRuntimeConfig {
  /** SSH host (can be hostname, user@host, or SSH config alias) */
  host: string;
  /** Working directory on remote host */
  srcBaseDir: string;
  /** Directory on remote for background process output (default: /tmp/mux-bashes) */
  bgOutputDir?: string;
  /** Optional: Path to SSH private key (if not using ~/.ssh/config or ssh-agent) */
  identityFile?: string;
  /** Optional: SSH port (default: 22) */
  port?: number;
}

/**
 * Connection health status
 */
export type ConnectionStatus = "healthy" | "unhealthy" | "unknown";

/**
 * Connection health state for a single SSH target
 */
export interface ConnectionHealth {
  status: ConnectionStatus;
  lastSuccess?: Date;
  lastFailure?: Date;
  lastError?: string;
  backoffUntil?: Date;
  consecutiveFailures: number;
}

/**
 * Backoff schedule in seconds: 1s → 5s → 10s → 20s → 40s → 60s (cap)
 */
const BACKOFF_SCHEDULE = [1, 5, 10, 20, 40, 60];

/**
 * Time after which a "healthy" connection should be re-probed.
 * Prevents stale health state when network silently degrades.
 */
const HEALTHY_TTL_MS = 15 * 1000; // 15 seconds

/**
 * SSH Connection Pool
 *
 * Call acquireConnection() before any SSH operation to ensure the connection
 * is healthy. This prevents thundering herd issues by:
 * 1. Returning immediately for known-healthy connections
 * 2. Coalescing concurrent probes via singleflighting
 * 3. Enforcing backoff after failures
 */
export class SSHConnectionPool {
  private health = new Map<string, ConnectionHealth>();
  private inflight = new Map<string, Promise<void>>();

  /**
   * Ensure connection is healthy before proceeding.
   *
   * @param config SSH configuration
   * @param timeoutMs Timeout for health check probe (default: 10s)
   * @throws Error if connection is in backoff or health check fails
   */
  async acquireConnection(config: SSHRuntimeConfig, timeoutMs = 10000): Promise<void> {
    const key = makeConnectionKey(config);
    const health = this.health.get(key);

    // Check if in backoff
    if (health?.backoffUntil && health.backoffUntil > new Date()) {
      const remainingSecs = Math.ceil((health.backoffUntil.getTime() - Date.now()) / 1000);
      throw new Error(
        `SSH connection to ${config.host} is in backoff for ${remainingSecs}s. ` +
          `Last error: ${health.lastError ?? "unknown"}`
      );
    }

    // Return immediately if known healthy and not stale
    if (health?.status === "healthy") {
      const age = Date.now() - (health.lastSuccess?.getTime() ?? 0);
      if (age < HEALTHY_TTL_MS) {
        log.debug(`SSH connection to ${config.host} is known healthy, skipping probe`);
        return;
      }
      log.debug(
        `SSH connection to ${config.host} health is stale (${Math.round(age / 1000)}s), re-probing`
      );
    }

    // Check for inflight probe - singleflighting
    const existing = this.inflight.get(key);
    if (existing) {
      log.debug(`SSH connection to ${config.host} has inflight probe, waiting...`);
      return existing;
    }

    // Start new probe
    log.debug(`SSH connection to ${config.host} needs probe, starting health check`);
    const probe = this.probeConnection(config, timeoutMs, key);
    this.inflight.set(key, probe);

    try {
      await probe;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Get current health status for a connection
   */
  getConnectionHealth(config: SSHRuntimeConfig): ConnectionHealth | undefined {
    const key = makeConnectionKey(config);
    return this.health.get(key);
  }

  /**
   * Get deterministic controlPath for SSH config.
   */
  getControlPath(config: SSHRuntimeConfig): string {
    return getControlPath(config);
  }

  /**
   * Reset backoff for a connection (e.g., after user intervention)
   */
  resetBackoff(config: SSHRuntimeConfig): void {
    const key = makeConnectionKey(config);
    const health = this.health.get(key);
    if (health) {
      health.backoffUntil = undefined;
      health.consecutiveFailures = 0;
      health.status = "unknown";
      log.info(`Reset backoff for SSH connection to ${config.host}`);
    }
  }

  /**
   * Mark connection as healthy.
   * Call after successful SSH operations to maintain health state.
   */
  markHealthy(config: SSHRuntimeConfig): void {
    const key = makeConnectionKey(config);
    this.markHealthyByKey(key);
  }

  /**
   * Report a connection failure.
   * Call when SSH operations fail due to connection issues (not command failures).
   * This triggers backoff to prevent thundering herd on a failing host.
   */
  reportFailure(config: SSHRuntimeConfig, error: string): void {
    const key = makeConnectionKey(config);
    this.markFailedByKey(key, error);
  }

  /**
   * Mark connection as healthy by key (internal use)
   */
  private markHealthyByKey(key: string): void {
    this.health.set(key, {
      status: "healthy",
      lastSuccess: new Date(),
      consecutiveFailures: 0,
    });
  }

  /**
   * Mark connection as failed (internal use after failed probe)
   */
  private markFailedByKey(key: string, error: string): void {
    const current = this.health.get(key);
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    const backoffIndex = Math.min(failures - 1, BACKOFF_SCHEDULE.length - 1);
    const backoffSecs = BACKOFF_SCHEDULE[backoffIndex];

    this.health.set(key, {
      status: "unhealthy",
      lastFailure: new Date(),
      lastError: error,
      backoffUntil: new Date(Date.now() + backoffSecs * 1000),
      consecutiveFailures: failures,
    });

    log.warn(
      `SSH connection failed (${failures} consecutive). Backoff for ${backoffSecs}s. Error: ${error}`
    );
  }

  /**
   * Probe connection health by running a simple command
   */
  private async probeConnection(
    config: SSHRuntimeConfig,
    timeoutMs: number,
    key: string
  ): Promise<void> {
    const controlPath = getControlPath(config);

    const args: string[] = ["-T"]; // No PTY needed for probe

    if (config.port) {
      args.push("-p", config.port.toString());
    }

    if (config.identityFile) {
      args.push("-i", config.identityFile);
      args.push("-o", "StrictHostKeyChecking=no");
      args.push("-o", "UserKnownHostsFile=/dev/null");
      args.push("-o", "LogLevel=ERROR");
    }

    // Connection multiplexing
    args.push("-o", "ControlMaster=auto");
    args.push("-o", `ControlPath=${controlPath}`);
    args.push("-o", "ControlPersist=60");

    // Aggressive timeouts for probe
    const connectTimeout = Math.min(Math.ceil(timeoutMs / 1000), 15);
    args.push("-o", `ConnectTimeout=${connectTimeout}`);
    args.push("-o", "ServerAliveInterval=5");
    args.push("-o", "ServerAliveCountMax=2");

    args.push(config.host, "echo ok");

    log.debug(`SSH probe: ssh ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
      const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
        const error = "SSH probe timed out";
        this.markFailedByKey(key, error);
        reject(new Error(error));
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) return; // Already handled by timeout

        if (code === 0) {
          this.markHealthyByKey(key);
          log.debug(`SSH probe to ${config.host} succeeded`);
          resolve();
        } else {
          const error = stderr.trim() || `SSH probe failed with code ${code ?? "unknown"}`;
          this.markFailedByKey(key, error);
          reject(new Error(error));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        const error = `SSH probe spawn error: ${err.message}`;
        this.markFailedByKey(key, error);
        reject(new Error(error));
      });
    });
  }
}

/**
 * Singleton instance for application-wide use
 */
export const sshConnectionPool = new SSHConnectionPool();

/**
 * Get deterministic controlPath for SSH config.
 * Multiple calls with identical config return the same path,
 * enabling ControlMaster to multiplex connections.
 *
 * Socket files are created by SSH and cleaned up automatically:
 * - ControlPersist=60: Removes socket 60s after last use
 * - OS: Cleans /tmp on reboot
 *
 * Includes local username in hash to prevent cross-user collisions on
 * multi-user systems (different users connecting to same remote would
 * otherwise generate same socket path, causing permission errors).
 */
export function getControlPath(config: SSHRuntimeConfig): string {
  const key = makeConnectionKey(config);
  const hash = hashKey(key);
  return path.join(os.tmpdir(), `mux-ssh-${hash}`);
}

/**
 * Generate stable key from config.
 * Identical configs produce identical keys.
 * Includes local username to prevent cross-user socket collisions.
 */
function makeConnectionKey(config: SSHRuntimeConfig): string {
  // Note: srcBaseDir is intentionally excluded - connection identity is determined
  // by user + host + port + key. This allows health tracking and multiplexing
  // to be shared across workspaces on the same host.
  const parts = [
    os.userInfo().username, // Include local user to prevent cross-user collisions
    config.host,
    config.port?.toString() ?? "22",
    config.identityFile ?? "default",
  ];
  return parts.join(":");
}

/**
 * Generate deterministic hash for controlPath naming.
 * Uses first 12 chars of SHA-256 for human-readable uniqueness.
 */
function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").substring(0, 12);
}
