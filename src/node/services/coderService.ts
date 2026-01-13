/**
 * Service for interacting with the Coder CLI.
 * Used to create/manage Coder workspaces as SSH targets for Mux workspaces.
 */
import { shescape } from "@/node/runtime/streamUtils";
import { execAsync } from "@/node/utils/disposableExec";
import { log } from "@/node/services/log";
import { spawn, type ChildProcess } from "child_process";
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

const SIGKILL_GRACE_PERIOD_MS = 5000;

function createGracefulTerminator(
  child: ChildProcess,
  options?: { sigkillAfterMs?: number }
): {
  terminate: () => void;
  cleanup: () => void;
} {
  const sigkillAfterMs = options?.sigkillAfterMs ?? SIGKILL_GRACE_PERIOD_MS;
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleSigkill = () => {
    if (sigkillTimer) return;
    sigkillTimer = setTimeout(() => {
      sigkillTimer = null;
      // Only attempt SIGKILL if the process still appears to be running.
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, sigkillAfterMs);
  };

  const terminate = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    scheduleSigkill();
  };

  const cleanup = () => {
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
      sigkillTimer = null;
    }
  };

  return { terminate, cleanup };
}

interface CoderCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: "timeout" | "aborted";
}

type InterpretedCoderCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string; combined: string };

function interpretCoderResult(result: CoderCommandResult): InterpretedCoderCommandResult {
  const combined = `${result.stderr}\n${result.stdout}`.trim();

  if (result.error) {
    return { ok: false, error: result.error, combined };
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: combined || `Exit code ${String(result.exitCode)}`,
      combined,
    };
  }

  return { ok: true, stdout: result.stdout, stderr: result.stderr };
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

      // CLI returns [{TemplatePreset: {ID, Name, ...}}, ...] wrapper structure
      const raw = JSON.parse(stdout) as Array<{
        TemplatePreset: {
          ID: string;
          Name: string;
          Description?: string;
          Default?: boolean;
        };
      }>;

      return raw.map((entry) => ({
        id: entry.TemplatePreset.ID,
        name: entry.TemplatePreset.Name,
        description: entry.TemplatePreset.Description,
        isDefault: entry.TemplatePreset.Default ?? false,
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
   * Check if a Coder workspace exists by name.
   *
   * Uses `coder list --search name:<workspace>` so we don't have to fetch all workspaces.
   * Note: Coder's `--search` is prefix-based server-side, so we must exact-match locally.
   */
  async workspaceExists(workspaceName: string): Promise<boolean> {
    try {
      using proc = execAsync(
        `coder list --search ${shescape.quote(`name:${workspaceName}`)} --output=json`
      );
      const { stdout } = await proc.result;

      if (!stdout.trim()) {
        return false;
      }

      const workspaces = JSON.parse(stdout) as Array<{ name: string }>;
      return workspaces.some((w) => w.name === workspaceName);
    } catch (error) {
      // Best-effort: if Coder isn't configured/logged in, treat as "doesn't exist" so we
      // don't block creation (later steps will fail with a more actionable error).
      log.debug("Failed to check if Coder workspace exists", { workspaceName, error });
      return false;
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
   * Run a `coder` CLI command with timeout + optional cancellation.
   *
   * We use spawn (not execAsync) so ensureReady() can't hang forever on a stuck
   * Coder CLI invocation.
   */
  private runCoderCommand(
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<CoderCommandResult> {
    return new Promise((resolve) => {
      if (options.timeoutMs <= 0) {
        resolve({ exitCode: null, stdout: "", stderr: "", error: "timeout" });
        return;
      }

      if (options.signal?.aborted) {
        resolve({ exitCode: null, stdout: "", stderr: "", error: "aborted" });
        return;
      }

      const child = spawn("coder", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let resolved = false;

      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const terminator = createGracefulTerminator(child);

      const resolveOnce = (result: CoderCommandResult) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };

      const cleanup = (cleanupOptions?: { keepSigkillTimer?: boolean }) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (!cleanupOptions?.keepSigkillTimer) {
          terminator.cleanup();
        }
        child.removeListener("close", onClose);
        child.removeListener("error", onError);
        options.signal?.removeEventListener("abort", onAbort);
      };

      function onAbort() {
        terminator.terminate();
        // Keep SIGKILL escalation alive if SIGTERM doesn't work.
        cleanup({ keepSigkillTimer: true });
        resolveOnce({ exitCode: null, stdout, stderr, error: "aborted" });
      }

      function onError() {
        cleanup();
        resolveOnce({ exitCode: null, stdout, stderr });
      }

      function onClose(code: number | null) {
        cleanup();
        resolveOnce({ exitCode: code, stdout, stderr });
      }

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });

      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", onError);
      child.on("close", onClose);

      timeoutTimer = setTimeout(() => {
        terminator.terminate();

        // Keep SIGKILL escalation alive if SIGTERM doesn't work.
        // We still remove the abort listener to avoid leaking it beyond the call.
        options.signal?.removeEventListener("abort", onAbort);

        resolveOnce({ exitCode: null, stdout, stderr, error: "timeout" });
      }, options.timeoutMs);

      options.signal?.addEventListener("abort", onAbort);
    });
  }

  /**
   * Get workspace status using control-plane query.
   *
   * Note: `coder list --search 'name:X'` is prefix-based on the server,
   * so we must exact-match the workspace name client-side.
   */
  async getWorkspaceStatus(
    workspaceName: string,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ status: CoderWorkspaceStatus | null; error?: string }> {
    const timeoutMs = options?.timeoutMs ?? 10_000;

    try {
      const result = await this.runCoderCommand(
        ["list", "--search", `name:${workspaceName}`, "--output", "json"],
        { timeoutMs, signal: options?.signal }
      );

      const interpreted = interpretCoderResult(result);
      if (!interpreted.ok) {
        return { status: null, error: interpreted.error };
      }

      if (!interpreted.stdout.trim()) {
        return { status: null, error: "Workspace not found" };
      }

      const workspaces = JSON.parse(interpreted.stdout) as Array<{
        name: string;
        latest_build: { status: string };
      }>;

      // Exact match required (search is prefix-based)
      const match = workspaces.find((w) => w.name === workspaceName);
      if (!match) {
        return { status: null, error: "Workspace not found" };
      }

      // Validate status against known schema values
      const status = match.latest_build.status;
      const parsed = CoderWorkspaceStatusSchema.safeParse(status);
      if (!parsed.success) {
        log.warn("Unknown Coder workspace status", { workspaceName, status });
        return { status: null, error: `Unknown status: ${status}` };
      }

      return { status: parsed.data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.debug("Failed to get Coder workspace status", { workspaceName, error: message });
      return { status: null, error: message };
    }
  }

  /**
   * Start a workspace and wait for it to be ready.
   * Blocks until the workspace is running (or timeout).
   *
   * @param workspaceName Workspace name
   * @param timeoutMs Maximum time to wait
   * @param signal Optional abort signal to cancel
   * @returns Object with success/error info
   */
  async startWorkspaceAndWait(
    workspaceName: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.runCoderCommand(["start", "-y", workspaceName], {
      timeoutMs,
      signal,
    });

    const interpreted = interpretCoderResult(result);

    if (interpreted.ok) {
      return { success: true };
    }

    if (interpreted.error === "aborted" || interpreted.error === "timeout") {
      return { success: false, error: interpreted.error };
    }

    if (interpreted.combined.includes("workspace build is already active")) {
      return { success: false, error: "build_in_progress" };
    }

    return {
      success: false,
      error: interpreted.error,
    };
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
    // TEMPORARY: Use workaround for parameter prompts.
    // Delete the workaround section below when `coder create --yes` no longer prompts
    // for parameters that have defaults.
    yield* this._createWorkspaceWithParamWorkaround(name, template, preset, abortSignal);
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

  // ============================================================================
  // TEMPORARY WORKAROUND: Parameter prompt retry logic
  // Delete this entire section when `coder create --yes` properly handles
  // parameters with defaults. Then update createWorkspace to run `coder create`
  // directly (without prompt-detection retries).
  // ============================================================================

  private async *_createWorkspaceWithParamWorkaround(
    name: string,
    template: string,
    preset: string | undefined,
    abortSignal: AbortSignal | undefined
  ): AsyncGenerator<string, void, unknown> {
    const MAX_PARAM_RETRIES = 20;
    const PROMPT_TIMEOUT_MS = 5000;

    const collectedParams: Array<{ name: string; value: string }> = [];

    for (let attempt = 0; attempt < MAX_PARAM_RETRIES; attempt++) {
      log.debug("Creating Coder workspace (workaround attempt)", {
        name,
        template,
        preset,
        attempt,
        collectedParams,
      });

      if (abortSignal?.aborted) {
        throw new Error("Coder workspace creation aborted");
      }

      const result = await this._tryCreateDetectingPrompts(
        name,
        template,
        preset,
        collectedParams,
        PROMPT_TIMEOUT_MS,
        abortSignal
      );

      if (result.type === "success") {
        for (const line of result.lines) {
          yield line;
        }
        return;
      }

      if (result.type === "prompt") {
        log.debug("Detected parameter prompt, will retry", { param: result.param, attempt });
        // Yield collected lines so user sees progress
        for (const line of result.lines) {
          yield line;
        }
        yield `[Detected parameter prompt "${result.param.name}", retrying with default "${result.param.value}"...]`;
        collectedParams.push(result.param);
        continue;
      }

      // Yield collected lines before throwing so user sees CLI output
      for (const line of result.lines) {
        yield line;
      }
      throw new Error(result.error);
    }

    throw new Error(
      `Too many parameter prompts (${MAX_PARAM_RETRIES}). ` +
        `Collected: ${collectedParams.map((p) => p.name).join(", ")}`
    );
  }

  private async _tryCreateDetectingPrompts(
    name: string,
    template: string,
    preset: string | undefined,
    extraParams: Array<{ name: string; value: string }>,
    promptTimeoutMs: number,
    abortSignal: AbortSignal | undefined
  ): Promise<
    | { type: "success"; lines: string[] }
    | { type: "prompt"; param: { name: string; value: string }; lines: string[] }
    | { type: "error"; error: string; lines: string[] }
  > {
    const args = ["create", name, "-t", template, "--yes"];
    if (preset) {
      args.push("--preset", preset);
    }
    for (const p of extraParams) {
      args.push("--parameter", `${p.name}=${p.value}`);
    }

    const child = spawn("coder", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminator = createGracefulTerminator(child);

    const lines: string[] = [];
    let rawOutput = "";
    let aborted = false;
    let promptDetected = false;

    const abortHandler = () => {
      aborted = true;
      terminator.terminate();
    };
    abortSignal?.addEventListener("abort", abortHandler);

    const processStream = async (stream: NodeJS.ReadableStream): Promise<void> => {
      for await (const chunk of stream) {
        const text = (chunk as Buffer).toString();
        rawOutput += text;
        for (const line of text.split("\n")) {
          if (line.trim()) {
            lines.push(line);
          }
        }
      }
    };

    const stdoutDone = processStream(child.stdout).catch((error: unknown) => {
      log.debug("Failed to read coder create stdout", { error });
    });
    const stderrDone = processStream(child.stderr).catch((error: unknown) => {
      log.debug("Failed to read coder create stderr", { error });
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });

    const promptCheckInterval = setInterval(() => {
      const parsed = this._parseParameterPrompt(rawOutput);
      if (parsed) {
        promptDetected = true;
        terminator.terminate();
        clearInterval(promptCheckInterval);
      }
    }, 200);

    const exitCode = await Promise.race([
      exitPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), promptTimeoutMs)),
    ]);

    clearInterval(promptCheckInterval);

    if (exitCode === "timeout") {
      const parsed = this._parseParameterPrompt(rawOutput);
      if (parsed) {
        terminator.terminate();

        const didExit = await Promise.race([
          exitPromise.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
        ]);
        if (didExit) {
          terminator.cleanup();
        }

        abortSignal?.removeEventListener("abort", abortHandler);
        return { type: "prompt", param: parsed, lines };
      }
      const finalExitCode = await exitPromise;
      await Promise.all([stdoutDone, stderrDone]);
      terminator.cleanup();
      abortSignal?.removeEventListener("abort", abortHandler);

      if (aborted) {
        return { type: "error", error: "Coder workspace creation aborted", lines };
      }
      if (finalExitCode !== 0) {
        return {
          type: "error",
          error: `coder create failed with exit code ${String(finalExitCode)}`,
          lines,
        };
      }
      return { type: "success", lines };
    }

    await Promise.all([stdoutDone, stderrDone]);
    terminator.cleanup();
    abortSignal?.removeEventListener("abort", abortHandler);

    if (aborted) {
      return { type: "error", error: "Coder workspace creation aborted", lines };
    }

    if (promptDetected) {
      const parsed = this._parseParameterPrompt(rawOutput);
      if (parsed) {
        return { type: "prompt", param: parsed, lines };
      }
    }

    if (exitCode !== 0) {
      const parsed = this._parseParameterPrompt(rawOutput);
      if (parsed) {
        return { type: "prompt", param: parsed, lines };
      }
      return {
        type: "error",
        error: `coder create failed with exit code ${String(exitCode)}`,
        lines,
      };
    }

    return { type: "success", lines };
  }

  private _parseParameterPrompt(output: string): { name: string; value: string } | null {
    const re = /^([^\n]+)\n {2}[^\n]+\n\n> Enter a value \(default: "([^"]*)"\):/m;
    const match = re.exec(output);
    return match ? { name: match[1].trim(), value: match[2] } : null;
  }

  // ============================================================================
  // END TEMPORARY WORKAROUND
  // ============================================================================
}

// Singleton instance
export const coderService = new CoderService();
