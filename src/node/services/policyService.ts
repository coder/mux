import { EventEmitter } from "events";
import { readFile } from "node:fs/promises";
import { log } from "@/node/services/log";
import {
  PolicyFileSchema,
  type EffectivePolicy,
  type PolicyGetResponse,
  type PolicyRuntimeId,
} from "@/common/orpc/schemas/policy";
import type { ProviderName } from "@/common/constants/providers";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { MCPServerTransport } from "@/common/types/mcp";
import { compareVersions } from "@/node/services/coderService";

import packageJson from "../../../package.json";

const POLICY_FETCH_TIMEOUT_MS = 10 * 1000;
const POLICY_MAX_BYTES = 1024 * 1024;
const POLICY_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((key) => [key, stableNormalize(obj[key])])
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

async function getClientVersion(): Promise<string> {
  // Prefer Electron's app version when available (authoritative in packaged apps).
  if (process.versions.electron) {
    try {
      // Intentionally lazy import to keep CLI/server mode light.
      // eslint-disable-next-line no-restricted-syntax
      const { app } = await import("electron");
      return app.getVersion();
    } catch {
      // Ignore and fall back.
    }
  }

  // Fallback for CLI/headless.
  if (typeof packageJson.version === "string") {
    return packageJson.version;
  }

  return "0.0.0";
}

function isRemotePolicySource(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

function formatPolicySourceForLog(source: string): string {
  if (!isRemotePolicySource(source)) {
    return source;
  }

  try {
    const url = new URL(source);
    // Intentionally omit credentials and query string.
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<policy-url>";
  }
}

async function loadPolicyText(source: string): Promise<string> {
  if (!isRemotePolicySource(source)) {
    try {
      return await readFile(source, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read policy file: ${message}`);
    }
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), POLICY_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(source, {
      signal: abortController.signal,
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > POLICY_MAX_BYTES) {
      throw new Error(`Response too large (${bytes} bytes)`);
    }

    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch policy URL (${formatPolicySourceForLog(source)}): ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
function normalizeForcedBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function parsePolicyFile(text: string): unknown {
  // Policy files are strict JSON (no JS evaluation).
  return JSON.parse(text) as unknown;
}

export type PolicyStatus =
  | { state: "disabled" }
  | { state: "enforced" }
  | { state: "blocked"; reason: string };

export class PolicyService {
  private readonly emitter = new EventEmitter();
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  private status: PolicyStatus = { state: "disabled" };
  private effectivePolicy: EffectivePolicy | null = null;
  private signature: string = stableStringify({
    status: this.status,
    policy: this.effectivePolicy,
  });

  constructor() {
    // Multiple windows can subscribe.
    this.emitter.setMaxListeners(50);
  }

  async initialize(): Promise<void> {
    await this.refreshPolicy({ isStartup: true });

    if (!this.refreshInterval) {
      this.refreshInterval = setInterval(() => {
        void this.refreshPolicy({ isStartup: false });
      }, POLICY_REFRESH_INTERVAL_MS);
      this.refreshInterval.unref?.();
    }
  }

  dispose(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  onPolicyChanged(callback: () => void): () => void {
    this.emitter.on("policyChanged", callback);
    return () => this.emitter.off("policyChanged", callback);
  }

  private emitPolicyChanged(): void {
    this.emitter.emit("policyChanged");
  }

  getPolicyGetResponse(): PolicyGetResponse {
    return {
      status: this.toSchemaStatus(this.status),
      policy: this.effectivePolicy,
    };
  }

  getEffectivePolicy(): EffectivePolicy | null {
    return this.effectivePolicy;
  }

  getStatus(): PolicyStatus {
    return this.status;
  }

  isEnforced(): boolean {
    // "blocked" should behave as deny-all enforcement so callers can't bypass the
    // UI block by calling backend endpoints directly (CLI/headless/orpc).
    return this.status.state !== "disabled";
  }

  isProviderAllowed(provider: ProviderName): boolean {
    if (this.status.state === "blocked") {
      return false;
    }

    const access = this.effectivePolicy?.providerAccess;
    if (access == null) {
      return true;
    }

    return access.some((p) => p.id === provider);
  }

  getForcedBaseUrl(provider: ProviderName): string | undefined {
    return this.effectivePolicy?.providerAccess?.find((p) => p.id === provider)?.forcedBaseUrl;
  }

  isModelAllowed(provider: ProviderName, modelId: string): boolean {
    if (this.status.state === "blocked") {
      return false;
    }

    const access = this.effectivePolicy?.providerAccess;
    if (access == null) {
      return true;
    }

    const providerPolicy = access.find((p) => p.id === provider);
    if (!providerPolicy) {
      return false;
    }

    const allowedModels = providerPolicy.allowedModels ?? null;
    if (allowedModels === null) {
      return true;
    }

    return allowedModels.includes(modelId);
  }

  isMcpTransportAllowed(transport: MCPServerTransport): boolean {
    if (this.status.state === "blocked") {
      return false;
    }

    const policy = this.effectivePolicy;
    if (!policy) {
      return true;
    }

    const allow = policy.mcp.allowUserDefined;
    if (transport === "stdio") {
      return allow.stdio;
    }

    // http/sse/auto are all remote.
    return allow.remote;
  }

  isRuntimeAllowed(runtimeConfig: RuntimeConfig | undefined): boolean {
    if (this.status.state === "blocked") {
      return false;
    }

    const runtimes = this.effectivePolicy?.runtimes;
    if (runtimes == null) {
      return true;
    }

    const runtimeId = this.getPolicyRuntimeId(runtimeConfig);
    return runtimeId != null && runtimes.includes(runtimeId);
  }

  getPolicyRuntimeId(runtimeConfig: RuntimeConfig | undefined): PolicyRuntimeId | null {
    if (!runtimeConfig) {
      // This matches the server default in workspaceService.create().
      return "worktree";
    }

    // Legacy local+srcBaseDir is treated as worktree.
    if (runtimeConfig.type === "local" && "srcBaseDir" in runtimeConfig) {
      return "worktree";
    }

    if (runtimeConfig.type === "ssh") {
      return runtimeConfig.coder ? "ssh+coder" : "ssh";
    }

    return runtimeConfig.type;
  }

  private async refreshPolicy(options: { isStartup: boolean }): Promise<void> {
    const filePath = process.env.MUX_POLICY_FILE?.trim();
    if (!filePath) {
      // Policy is opt-in.
      this.updateState({ state: "disabled" }, null);
      return;
    }

    try {
      const [clientVersion, fileText] = await Promise.all([
        getClientVersion(),
        loadPolicyText(filePath),
      ]);

      const raw = parsePolicyFile(fileText);
      const parsed = PolicyFileSchema.parse(raw);

      // Version gates
      if (parsed.minimum_client_version) {
        const min = parsed.minimum_client_version;
        if (compareVersions(clientVersion, min) < 0) {
          this.updateState(
            {
              state: "blocked",
              reason: `Mux ${clientVersion} is below required minimum_client_version ${min}`,
            },
            null
          );
          return;
        }
      }

      const providerAccess = (() => {
        const list = parsed.provider_access;
        if (!list || list.length === 0) {
          return null;
        }

        return list.map((p) => {
          const forcedBaseUrl = normalizeForcedBaseUrl(p.base_url);

          const models = p.model_access;
          if (!models || models.length === 0) {
            return { id: p.id, forcedBaseUrl, allowedModels: null };
          }

          // Normalize + drop empties. An empty list means "allow all".
          const normalized = models.map((m) => m.trim()).filter(Boolean);
          if (normalized.length === 0) {
            return { id: p.id, forcedBaseUrl, allowedModels: null };
          }

          return { id: p.id, forcedBaseUrl, allowedModels: normalized };
        });
      })();

      const allowUserDefined = parsed.tools?.allow_user_defined_mcp;
      const effective: EffectivePolicy = {
        policyFormatVersion: "0.1",
        serverVersion: parsed.server_version,
        minimumClientVersion: parsed.minimum_client_version,

        providerAccess,

        mcp: {
          allowUserDefined: {
            stdio: allowUserDefined?.stdio ?? true,
            remote: allowUserDefined?.remote ?? true,
          },
        },

        runtimes:
          parsed.runtimes && parsed.runtimes.length > 0 ? parsed.runtimes.map((r) => r.id) : null,
      };

      this.updateState({ state: "enforced" }, effective);
    } catch (error) {
      if (options.isStartup) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateState({ state: "blocked", reason: `Failed to load policy: ${message}` }, null);
        return;
      }

      // Refresh failures should not unlock the user; keep last-known-good.
      log.warn("Policy refresh failed; keeping last-known-good policy", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private updateState(status: PolicyStatus, policy: EffectivePolicy | null): void {
    const nextSignature = stableStringify({ status, policy });
    if (nextSignature === this.signature) {
      return;
    }

    this.status = status;
    this.effectivePolicy = policy;
    this.signature = nextSignature;
    this.emitPolicyChanged();
  }

  private toSchemaStatus(status: PolicyStatus): PolicyGetResponse["status"] {
    if (status.state === "disabled") {
      return { state: "disabled" };
    }
    if (status.state === "enforced") {
      return { state: "enforced" };
    }
    return { state: "blocked", reason: status.reason };
  }
}
