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

/** Discriminated union for workspace status check results */
export type WorkspaceStatusResult =
  | { kind: "ok"; status: CoderWorkspaceStatus }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

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
   * Get the Coder deployment URL via `coder whoami`.
   * Throws if Coder CLI is not configured/logged in.
   */
  private async getDeploymentUrl(): Promise<string> {
    using proc = execAsync("coder whoami --output json");
    const { stdout } = await proc.result;

    const data = JSON.parse(stdout) as Array<{ url: string }>;
    if (!data[0]?.url) {
      throw new Error("Could not determine Coder deployment URL from `coder whoami`");
    }
    return data[0].url;
  }

  /**
   * Get the active template version ID for a template.
   * Throws if template not found.
   */
  private async getActiveTemplateVersionId(templateName: string): Promise<string> {
    using proc = execAsync("coder templates list --output=json");
    const { stdout } = await proc.result;

    if (!stdout.trim()) {
      throw new Error(`Template "${templateName}" not found (no templates exist)`);
    }

    const raw = JSON.parse(stdout) as Array<{
      Template: {
        name: string;
        active_version_id: string;
      };
    }>;

    const template = raw.find((t) => t.Template.name === templateName);
    if (!template) {
      throw new Error(`Template "${templateName}" not found`);
    }

    return template.Template.active_version_id;
  }

  /**
   * Get parameter names covered by a preset.
   * Returns empty set if preset not found (allows creation to proceed without preset params).
   */
  private async getPresetParamNames(
    templateName: string,
    presetName: string
  ): Promise<Set<string>> {
    try {
      using proc = execAsync(
        `coder templates presets list ${shescape.quote(templateName)} --output=json`
      );
      const { stdout } = await proc.result;

      if (!stdout.trim()) {
        return new Set();
      }

      const raw = JSON.parse(stdout) as Array<{
        TemplatePreset: {
          Name: string;
          Parameters?: Array<{ Name: string }>;
        };
      }>;

      const preset = raw.find((p) => p.TemplatePreset.Name === presetName);
      if (!preset?.TemplatePreset.Parameters) {
        return new Set();
      }

      return new Set(preset.TemplatePreset.Parameters.map((p) => p.Name));
    } catch (error) {
      log.debug("Failed to get preset param names", { templateName, presetName, error });
      return new Set();
    }
  }

  /**
   * Parse rich parameter data from the Coder API.
   * Filters out entries with missing/invalid names to avoid generating invalid --parameter flags.
   */
  private parseRichParameters(data: unknown): Array<{
    name: string;
    defaultValue: string;
    type: string;
    ephemeral: boolean;
    required: boolean;
  }> {
    if (!Array.isArray(data)) {
      throw new Error("Expected array of rich parameters");
    }
    return data
      .filter((p): p is Record<string, unknown> => {
        if (p === null || typeof p !== "object") return false;
        const obj = p as Record<string, unknown>;
        return typeof obj.name === "string" && obj.name !== "";
      })
      .map((p) => ({
        name: p.name as string,
        defaultValue: typeof p.default_value === "string" ? p.default_value : "",
        type: typeof p.type === "string" ? p.type : "string",
        ephemeral: Boolean(p.ephemeral),
        required: Boolean(p.required),
      }));
  }

  /**
   * Fetch template rich parameters from Coder API.
   * Creates a short-lived token, fetches params, then cleans up the token.
   */
  private async getTemplateRichParameters(
    deploymentUrl: string,
    versionId: string,
    workspaceName: string
  ): Promise<
    Array<{
      name: string;
      defaultValue: string;
      type: string;
      ephemeral: boolean;
      required: boolean;
    }>
  > {
    // Create short-lived token named after workspace (avoids keychain read issues)
    const tokenName = `mux-${workspaceName}`;
    using tokenProc = execAsync(
      `coder tokens create --lifetime 5m --name ${shescape.quote(tokenName)}`
    );
    const { stdout: token } = await tokenProc.result;

    try {
      const url = new URL(
        `/api/v2/templateversions/${versionId}/rich-parameters`,
        deploymentUrl
      ).toString();

      const response = await fetch(url, {
        headers: {
          "Coder-Session-Token": token.trim(),
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch rich parameters: ${response.status} ${response.statusText}`
        );
      }

      const data: unknown = await response.json();
      return this.parseRichParameters(data);
    } finally {
      // Clean up the token by name
      try {
        using deleteProc = execAsync(`coder tokens delete ${shescape.quote(tokenName)} --yes`);
        await deleteProc.result;
      } catch {
        // Best-effort cleanup; token will expire in 5 minutes anyway
        log.debug("Failed to delete temporary token", { tokenName });
      }
    }
  }

  /**
   * Encode a parameter string for the Coder CLI's --parameter flag.
   * The CLI uses CSV parsing, so values containing quotes or commas need escaping:
   * - Wrap the entire string in double quotes
   * - Escape internal double quotes as ""
   */
  private encodeParameterValue(nameValue: string): string {
    if (!nameValue.includes('"') && !nameValue.includes(",")) {
      return nameValue;
    }
    // CSV quoting: wrap in quotes, escape internal quotes as ""
    return `"${nameValue.replace(/"/g, '""')}"`;
  }

  /**
   * Compute extra --parameter flags needed for workspace creation.
   * Filters to non-ephemeral params not covered by preset, using their defaults.
   * Values are passed through as-is (list(string) types expect JSON-encoded arrays).
   */
  computeExtraParams(
    allParams: Array<{
      name: string;
      defaultValue: string;
      type: string;
      ephemeral: boolean;
      required: boolean;
    }>,
    coveredByPreset: Set<string>
  ): Array<{ name: string; encoded: string }> {
    const extra: Array<{ name: string; encoded: string }> = [];

    for (const p of allParams) {
      // Skip ephemeral params
      if (p.ephemeral) continue;
      // Skip params covered by preset
      if (coveredByPreset.has(p.name)) continue;

      // Encode for CLI's CSV parser (escape quotes/commas)
      const encoded = this.encodeParameterValue(`${p.name}=${p.defaultValue}`);
      extra.push({ name: p.name, encoded });
    }

    return extra;
  }

  /**
   * Validate that all required params have values (either from preset or defaults).
   * Throws if any required param is missing a value.
   */
  validateRequiredParams(
    allParams: Array<{
      name: string;
      defaultValue: string;
      type: string;
      ephemeral: boolean;
      required: boolean;
    }>,
    coveredByPreset: Set<string>
  ): void {
    const missing: string[] = [];

    for (const p of allParams) {
      if (p.ephemeral) continue;
      if (p.required && !p.defaultValue && !coveredByPreset.has(p.name)) {
        missing.push(p.name);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Required template parameters missing values: ${missing.join(", ")}. ` +
          `Select a preset that provides these values or contact your template admin.`
      );
    }
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
  ): Promise<WorkspaceStatusResult> {
    const timeoutMs = options?.timeoutMs ?? 10_000;

    try {
      const result = await this.runCoderCommand(
        ["list", "--search", `name:${workspaceName}`, "--output", "json"],
        { timeoutMs, signal: options?.signal }
      );

      const interpreted = interpretCoderResult(result);
      if (!interpreted.ok) {
        return { kind: "error", error: interpreted.error };
      }

      if (!interpreted.stdout.trim()) {
        return { kind: "not_found" };
      }

      const workspaces = JSON.parse(interpreted.stdout) as Array<{
        name: string;
        latest_build: { status: string };
      }>;

      // Exact match required (search is prefix-based)
      const match = workspaces.find((w) => w.name === workspaceName);
      if (!match) {
        return { kind: "not_found" };
      }

      // Validate status against known schema values
      const status = match.latest_build.status;
      const parsed = CoderWorkspaceStatusSchema.safeParse(status);
      if (!parsed.success) {
        log.warn("Unknown Coder workspace status", { workspaceName, status });
        return { kind: "error", error: `Unknown status: ${status}` };
      }

      return { kind: "ok", status: parsed.data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.debug("Failed to get Coder workspace status", { workspaceName, error: message });
      return { kind: "error", error: message };
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
   *
   * Pre-fetches template parameters and passes defaults via --parameter flags
   * to avoid interactive prompts during creation.
   *
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
    log.debug("Creating Coder workspace", { name, template, preset });

    if (abortSignal?.aborted) {
      throw new Error("Coder workspace creation aborted");
    }

    // 1. Get deployment URL
    const deploymentUrl = await this.getDeploymentUrl();

    // 2. Get active template version ID
    const versionId = await this.getActiveTemplateVersionId(template);

    // 3. Get parameter names covered by preset (if any)
    const coveredByPreset = preset
      ? await this.getPresetParamNames(template, preset)
      : new Set<string>();

    // 4. Fetch all template parameters from API
    const allParams = await this.getTemplateRichParameters(deploymentUrl, versionId, name);

    // 5. Validate required params have values
    this.validateRequiredParams(allParams, coveredByPreset);

    // 6. Compute extra --parameter flags for non-ephemeral params not in preset
    const extraParams = this.computeExtraParams(allParams, coveredByPreset);

    log.debug("Computed extra params for coder create", {
      name,
      template,
      preset,
      extraParamCount: extraParams.length,
      extraParamNames: extraParams.map((p) => p.name),
    });

    // 7. Build and run single coder create command
    const args = ["create", name, "-t", template, "--yes"];
    if (preset) {
      args.push("--preset", preset);
    }
    for (const p of extraParams) {
      args.push("--parameter", p.encoded);
    }

    // Yield the command we're about to run so it's visible in UI
    yield `$ coder ${args.join(" ")}`;

    const child = spawn("coder", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const terminator = createGracefulTerminator(child);

    const abortHandler = () => {
      terminator.terminate();
    };
    abortSignal?.addEventListener("abort", abortHandler);

    try {
      // Use an async queue to stream lines as they arrive (not buffer until end)
      const lineQueue: string[] = [];
      let streamsDone = false;
      let resolveNext: (() => void) | null = null;

      const pushLine = (line: string) => {
        lineQueue.push(line);
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      };

      // Set up stream processing
      let pending = 2;
      const markDone = () => {
        pending--;
        if (pending === 0) {
          streamsDone = true;
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
        }
      };

      const processStream = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) {
          markDone();
          return;
        }
        let buffer = "";
        stream.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const line of parts) {
            const trimmed = line.trim();
            if (trimmed) pushLine(trimmed);
          }
        });
        stream.on("end", () => {
          if (buffer.trim()) pushLine(buffer.trim());
          markDone();
        });
        stream.on("error", markDone);
      };

      processStream(child.stdout);
      processStream(child.stderr);

      // Yield lines as they arrive
      while (!streamsDone || lineQueue.length > 0) {
        if (lineQueue.length > 0) {
          yield lineQueue.shift()!;
        } else if (!streamsDone) {
          // Wait for more data
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      }

      // Wait for process to exit
      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("close", resolve);
        child.on("error", () => resolve(null));
      });

      if (abortSignal?.aborted) {
        throw new Error("Coder workspace creation aborted");
      }

      if (exitCode !== 0) {
        throw new Error(`coder create failed with exit code ${String(exitCode)}`);
      }
    } finally {
      terminator.cleanup();
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
