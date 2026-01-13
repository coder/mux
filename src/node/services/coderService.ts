/**
 * Service for interacting with the Coder CLI.
 * Used to create/manage Coder workspaces as SSH targets for Mux workspaces.
 */
import { shescape } from "@/node/runtime/streamUtils";
import { execAsync } from "@/node/utils/disposableExec";
import { log } from "@/node/services/log";
import { spawn } from "child_process";
import {
  CoderWorkspaceStatusSchema,
  type CoderInfo,
  type CoderTemplate,
  type CoderPreset,
  type CoderWorkspace,
  type CoderWorkspaceStatus,
} from "@/common/orpc/schemas/coder";

// Re-export types for consumers that import from this module
export type { CoderInfo, CoderTemplate, CoderPreset, CoderWorkspace, CoderWorkspaceStatus };

// Minimum supported Coder CLI version
const MIN_CODER_VERSION = "2.25.0";

/**
 * Normalize a version string for comparison.
 * Strips leading "v", dev suffixes like "-devel+hash", and build metadata.
 * Example: "v2.28.6+df47153" → "2.28.6"
 */
function normalizeVersion(v: string): string {
  return v
    .replace(/^v/i, "") // Strip leading v/V
    .split("-")[0] // Remove pre-release suffix
    .split("+")[0]; // Remove build metadata
}

/**
 * Compare two semver versions. Returns:
 * - negative if a < b
 * - 0 if a === b
 * - positive if a > b
 */
export function compareVersions(a: string, b: string): number {
  const aParts = normalizeVersion(a).split(".").map(Number);
  const bParts = normalizeVersion(b).split(".").map(Number);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] ?? 0;
    const bPart = bParts[i] ?? 0;
    if (aPart !== bPart) return aPart - bPart;
  }
  return 0;
}

export class CoderService {
  private cachedInfo: CoderInfo | null = null;

  /**
   * Get Coder CLI info. Caches result for the session.
   * Returns { available: false } if CLI not installed or version too old.
   */
  async getCoderInfo(): Promise<CoderInfo> {
    if (this.cachedInfo) {
      return this.cachedInfo;
    }

    try {
      using proc = execAsync("coder version --output=json");
      const { stdout } = await proc.result;

      // Parse JSON output
      const data = JSON.parse(stdout) as { version?: string };
      const version = data.version;

      if (!version) {
        this.cachedInfo = { available: false };
        return this.cachedInfo;
      }

      // Check minimum version
      if (compareVersions(version, MIN_CODER_VERSION) < 0) {
        log.debug(`Coder CLI version ${version} is below minimum ${MIN_CODER_VERSION}`);
        this.cachedInfo = { available: false };
        return this.cachedInfo;
      }

      this.cachedInfo = { available: true, version };
      return this.cachedInfo;
    } catch (error) {
      log.debug("Coder CLI not available", { error });
      this.cachedInfo = { available: false };
      return this.cachedInfo;
    }
  }

  /**
   * Clear cached Coder info. Used for testing.
   */
  clearCache(): void {
    this.cachedInfo = null;
  }

  /**
   * List available Coder templates.
   */
  async listTemplates(): Promise<CoderTemplate[]> {
    try {
      using proc = execAsync("coder templates list --output=json");
      const { stdout } = await proc.result;

      // Handle empty output (no templates)
      if (!stdout.trim()) {
        return [];
      }

      // CLI returns [{Template: {...}}, ...] wrapper structure
      const raw = JSON.parse(stdout) as Array<{
        Template: {
          name: string;
          display_name?: string;
          organization_name?: string;
        };
      }>;

      return raw.map((entry) => ({
        name: entry.Template.name,
        displayName: entry.Template.display_name ?? entry.Template.name,
        organizationName: entry.Template.organization_name ?? "default",
      }));
    } catch (error) {
      // Common user state: Coder CLI installed but not configured/logged in.
      // Don't spam error logs for UI list calls.
      log.debug("Failed to list Coder templates", { error });
      return [];
    }
  }

  /**
   * List presets for a template.
   */
  async listPresets(templateName: string): Promise<CoderPreset[]> {
    try {
      using proc = execAsync(
        `coder templates presets list ${shescape.quote(templateName)} --output=json`
      );
      const { stdout } = await proc.result;

      // Handle empty output (no presets)
      if (!stdout.trim()) {
        return [];
      }

      const presets = JSON.parse(stdout) as Array<{
        id: string;
        name: string;
        description?: string;
        is_default?: boolean;
      }>;

      return presets.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        isDefault: p.is_default ?? false,
      }));
    } catch (error) {
      log.debug("Failed to list Coder presets (may not exist for template)", {
        templateName,
        error,
      });
      return [];
    }
  }

  /**
   * List Coder workspaces. Only returns "running" workspaces by default.
   */
  async listWorkspaces(filterRunning = true): Promise<CoderWorkspace[]> {
    // Derive known statuses from schema to avoid duplication and prevent ORPC validation errors
    const KNOWN_STATUSES = new Set<string>(CoderWorkspaceStatusSchema.options);

    try {
      using proc = execAsync("coder list --output=json");
      const { stdout } = await proc.result;

      // Handle empty output (no workspaces)
      if (!stdout.trim()) {
        return [];
      }

      const workspaces = JSON.parse(stdout) as Array<{
        name: string;
        template_name: string;
        latest_build: {
          status: string;
        };
      }>;

      // Filter to known statuses first to avoid ORPC schema validation failures
      const mapped = workspaces
        .filter((w) => KNOWN_STATUSES.has(w.latest_build.status))
        .map((w) => ({
          name: w.name,
          templateName: w.template_name,
          status: w.latest_build.status as CoderWorkspaceStatus,
        }));

      if (filterRunning) {
        return mapped.filter((w) => w.status === "running");
      }
      return mapped;
    } catch (error) {
      // Common user state: Coder CLI installed but not configured/logged in.
      // Don't spam error logs for UI list calls.
      log.debug("Failed to list Coder workspaces", { error });
      return [];
    }
  }

  /**
   * Create a new Coder workspace. Yields build log lines as they arrive.
   * Streams stdout and stderr concurrently to avoid blocking on either stream.
   * @param name Workspace name
   * @param template Template name
   * @param preset Optional preset name
   * @param abortSignal Optional signal to cancel workspace creation
   */
  async *createWorkspace(
    name: string,
    template: string,
    preset?: string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const args = ["create", name, "-t", template, "--yes"];
    if (preset) {
      args.push("--preset", preset);
    }

    log.debug("Creating Coder workspace", { name, template, preset, args });

    // Check if already aborted before spawning
    if (abortSignal?.aborted) {
      throw new Error("Coder workspace creation aborted");
    }

    const child = spawn("coder", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Set up abort handler to kill the child process
    let aborted = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
    const abortHandler = () => {
      aborted = true;
      child.kill("SIGTERM");
      // Force kill after 5 seconds if SIGTERM doesn't work
      sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    abortSignal?.addEventListener("abort", abortHandler);

    try {
      // Collect lines from both streams into a shared queue
      const lines: string[] = [];
      let readIndex = 0; // Index-based iteration to avoid O(n²) shift()
      let streamsDone = false;
      let streamError: Error | null = null;

      const processStream = async (stream: NodeJS.ReadableStream): Promise<void> => {
        for await (const chunk of stream) {
          for (const line of (chunk as Buffer).toString().split("\n")) {
            if (line.trim()) {
              lines.push(line);
            }
          }
        }
      };

      // Start both stream processors concurrently (don't await yet)
      const stdoutDone = processStream(child.stdout).catch((e: unknown) => {
        streamError = streamError ?? (e instanceof Error ? e : new Error(String(e)));
      });
      const stderrDone = processStream(child.stderr).catch((e: unknown) => {
        streamError = streamError ?? (e instanceof Error ? e : new Error(String(e)));
      });

      // Attach close/error handlers immediately to avoid missing events
      // Note: `close` can report exitCode=null when the process is terminated by signal.
      const exitPromise = new Promise<number>((resolve, reject) => {
        child.on("close", (exitCode) => resolve(exitCode ?? -1));
        child.on("error", reject);
      });

      // Yield lines as they arrive, polling until streams complete
      while (!streamsDone) {
        // Check for abort
        if (aborted) {
          throw new Error("Coder workspace creation aborted");
        }

        // Drain any available lines using index-based iteration (O(1) per line vs O(n) for shift)
        while (readIndex < lines.length) {
          yield lines[readIndex++];
        }
        // Compact array periodically to avoid unbounded memory growth
        if (readIndex > 500) {
          lines.splice(0, readIndex);
          readIndex = 0;
        }

        // Check if streams are done (non-blocking race)
        const bothDone = await Promise.race([
          Promise.all([stdoutDone, stderrDone]).then(() => true),
          new Promise<false>((r) => setTimeout(() => r(false), 50)),
        ]);
        if (bothDone) {
          streamsDone = true;
        }
      }

      // Drain any remaining lines after streams close
      while (readIndex < lines.length) {
        yield lines[readIndex++];
      }

      if (aborted) {
        throw new Error("Coder workspace creation aborted");
      }

      if (streamError !== null) {
        const err: Error = streamError;
        throw err;
      }

      const exitCode = await exitPromise;
      if (exitCode !== 0) {
        throw new Error(`coder create failed with exit code ${String(exitCode)}`);
      }
    } finally {
      if (sigkillTimer) clearTimeout(sigkillTimer);
      abortSignal?.removeEventListener("abort", abortHandler);
    }
  }

  /**
   * Delete a Coder workspace.
   */
  async deleteWorkspace(name: string): Promise<void> {
    log.debug("Deleting Coder workspace", { name });
    using proc = execAsync(`coder delete ${shescape.quote(name)} --yes`);
    await proc.result;
  }

  /**
   * Ensure SSH config is set up for Coder workspaces.
   * Run before every Coder workspace connection (idempotent).
   */
  async ensureSSHConfig(): Promise<void> {
    log.debug("Ensuring Coder SSH config");
    using proc = execAsync("coder config-ssh --yes");
    await proc.result;
  }
}

// Singleton instance
export const coderService = new CoderService();
