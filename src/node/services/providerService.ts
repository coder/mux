import { EventEmitter } from "events";
import type { Config } from "@/node/config";
import { SUPPORTED_PROVIDERS, type ProviderName } from "@/common/constants/providers";
import type { Result } from "@/common/types/result";
import type {
  AWSCredentialStatus,
  ProviderConfigInfo,
  ProviderModelEntry,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import {
  getProviderModelEntryId,
  normalizeProviderModelEntries,
} from "@/common/utils/providers/modelEntries";
import { log } from "@/node/services/log";
import { checkProviderConfigured } from "@/node/utils/providerRequirements";
import { parseCodexOauthAuth } from "@/node/utils/codexOauthAuth";
import type { PolicyService } from "@/node/services/policyService";
import { getErrorMessage } from "@/common/utils/errors";

// Re-export types for backward compatibility
export type { AWSCredentialStatus, ProviderConfigInfo, ProvidersConfigMap };

function filterProviderModelsByPolicy(
  models: ProviderModelEntry[] | undefined,
  allowedModels: string[] | null
): ProviderModelEntry[] | undefined {
  if (!models) {
    return undefined;
  }

  if (!Array.isArray(allowedModels)) {
    return models;
  }

  return models.filter((entry) => allowedModels.includes(getProviderModelEntryId(entry)));
}

export class ProviderService {
  private readonly policyService: PolicyService | null;
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly config: Config,
    policyService?: PolicyService
  ) {
    this.policyService = policyService ?? null;
    // The provider config subscription may have many concurrent listeners (e.g. multiple windows).
    // Avoid noisy MaxListenersExceededWarning for normal usage.
    this.emitter.setMaxListeners(50);
  }

  /**
   * Subscribe to config change events. Used by oRPC subscription handler.
   * Returns a cleanup function.
   */
  onConfigChanged(callback: () => void): () => void {
    this.emitter.on("configChanged", callback);
    return () => this.emitter.off("configChanged", callback);
  }

  /**
   * Notify subscribers that provider-relevant config has changed.
   * Called internally on provider config edits, and externally when
   * main config changes affect provider availability (e.g. muxGatewayEnabled).
   */
  notifyConfigChanged(): void {
    this.emitter.emit("configChanged");
  }

  public list(): ProviderName[] {
    try {
      const providers = [...SUPPORTED_PROVIDERS];

      if (this.policyService?.isEnforced()) {
        return providers.filter((p) => this.policyService!.isProviderAllowed(p));
      }

      return providers;
    } catch (error) {
      log.error("Failed to list providers:", error);
      return [];
    }
  }

  /**
   * Get the full providers config with safe info (no actual API keys)
   */
  public getConfig(): ProvidersConfigMap {
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const mainConfig = this.config.loadConfigOrDefault();
    const result: ProvidersConfigMap = {};

    for (const provider of this.list()) {
      const config = (providersConfig[provider] ?? {}) as {
        apiKey?: string;
        baseUrl?: string;
        models?: unknown[];
        serviceTier?: unknown;
        cacheTtl?: unknown;
        /** OpenAI-only: default auth precedence for Codex-OAuth-allowed models. */
        codexOauthDefaultAuth?: unknown;
        region?: string;
        /** Optional AWS shared config profile name (equivalent to AWS_PROFILE). */
        profile?: string;
        bearerToken?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        /** Persisted provider toggle: only `false` is stored; missing means enabled. */
        enabled?: unknown;
        /** OpenAI-only: stored Codex OAuth tokens (never sent to frontend). */
        codexOauth?: unknown;
      };

      const forcedBaseUrl = this.policyService?.isEnforced()
        ? this.policyService.getForcedBaseUrl(provider)
        : undefined;

      const allowedModels = this.policyService?.isEnforced()
        ? (this.policyService.getEffectivePolicy()?.providerAccess?.find((p) => p.id === provider)
            ?.allowedModels ?? null)
        : null;

      const normalizedModels =
        config.models === undefined ? undefined : normalizeProviderModelEntries(config.models);
      const filteredModels = filterProviderModelsByPolicy(normalizedModels, allowedModels);

      const codexOauthSet =
        provider === "openai" && parseCodexOauthAuth(config.codexOauth) !== null;
      let isEnabled = !isProviderDisabledInConfig(config);
      if (provider === "mux-gateway" && mainConfig.muxGatewayEnabled === false) {
        isEnabled = false;
      }

      const providerInfo: ProviderConfigInfo = {
        apiKeySet: !!config.apiKey,
        // Users can disable providers without removing credentials from providers.jsonc.
        isEnabled,
        isConfigured: false, // computed below
        baseUrl: forcedBaseUrl ?? config.baseUrl,
        models: filteredModels,
      };

      // OpenAI-specific fields
      const serviceTier = config.serviceTier;
      if (
        provider === "openai" &&
        (serviceTier === "auto" ||
          serviceTier === "default" ||
          serviceTier === "flex" ||
          serviceTier === "priority")
      ) {
        providerInfo.serviceTier = serviceTier;
      }

      // Anthropic-specific fields
      const cacheTtl = config.cacheTtl;
      if (provider === "anthropic" && (cacheTtl === "5m" || cacheTtl === "1h")) {
        providerInfo.cacheTtl = cacheTtl;
      }

      if (provider === "openai") {
        providerInfo.codexOauthSet = codexOauthSet;

        const codexOauthDefaultAuth = config.codexOauthDefaultAuth;
        if (codexOauthDefaultAuth === "oauth" || codexOauthDefaultAuth === "apiKey") {
          providerInfo.codexOauthDefaultAuth = codexOauthDefaultAuth;
        }
      }
      // AWS/Bedrock-specific fields
      if (provider === "bedrock") {
        providerInfo.aws = {
          region: config.region,
          profile: config.profile,
          bearerTokenSet: !!config.bearerToken,
          accessKeyIdSet: !!config.accessKeyId,
          secretAccessKeySet: !!config.secretAccessKey,
        };
      }

      // Mux Gateway-specific fields (check couponCode first, fallback to legacy voucher)
      if (provider === "mux-gateway") {
        const muxConfig = config as { couponCode?: string; voucher?: string };
        providerInfo.couponCodeSet = !!(muxConfig.couponCode ?? muxConfig.voucher);
      }

      // Compute isConfigured using shared utility (checks config + env vars).
      // Disabled providers intentionally surface as not configured in the UI.
      providerInfo.isConfigured =
        isEnabled && checkProviderConfigured(provider, config).isConfigured;

      if (provider === "openai" && isEnabled && codexOauthSet) {
        providerInfo.isConfigured = true;
      }

      result[provider] = providerInfo;
    }

    return result;
  }

  /**
   * Set custom models for a provider
   */
  public setModels(provider: string, models: ProviderModelEntry[]): Result<void, string> {
    try {
      const normalizedModels = normalizeProviderModelEntries(models);

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isProviderAllowed(provider as ProviderName)) {
          return { success: false, error: `Provider ${provider} is not allowed by policy` };
        }

        const allowedModels =
          this.policyService
            .getEffectivePolicy()
            ?.providerAccess?.find((p) => p.id === (provider as ProviderName))?.allowedModels ??
          null;

        if (Array.isArray(allowedModels)) {
          const disallowed = normalizedModels
            .map((entry) => getProviderModelEntryId(entry))
            .filter((modelId) => !allowedModels.includes(modelId));
          if (disallowed.length > 0) {
            return {
              success: false,
              error: `One or more models are not allowed by policy: ${disallowed.join(", ")}`,
            };
          }
        }
      }

      const providersConfig = this.config.loadProvidersConfig() ?? {};

      if (!providersConfig[provider]) {
        providersConfig[provider] = {};
      }

      providersConfig[provider].models = normalizedModels;
      this.config.saveProvidersConfig(providersConfig);
      this.notifyConfigChanged();

      return { success: true, data: undefined };
    } catch (error) {
      const message = getErrorMessage(error);
      return { success: false, error: `Failed to set models: ${message}` };
    }
  }

  /**
   * Set provider config values that aren't representable as strings.
   *
   * Intended for persisted auth blobs (e.g. Codex OAuth tokens) that should never
   * cross the frontend boundary.
   */
  public setConfigValue(provider: string, keyPath: string[], value: unknown): Result<void, string> {
    try {
      // Load current providers config or create empty
      const providersConfig = this.config.loadProvidersConfig() ?? {};

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isProviderAllowed(provider as ProviderName)) {
          return { success: false, error: `Provider ${provider} is not allowed by policy` };
        }

        const forcedBaseUrl = this.policyService.getForcedBaseUrl(provider as ProviderName);
        const isBaseUrlEdit = keyPath.length === 1 && keyPath[0] === "baseUrl";
        if (isBaseUrlEdit && forcedBaseUrl) {
          return { success: false, error: `Provider ${provider} base URL is locked by policy` };
        }
      }

      // Ensure provider exists
      if (!providersConfig[provider]) {
        providersConfig[provider] = {};
      }

      // Set nested property value
      let current = providersConfig[provider] as Record<string, unknown>;
      for (let i = 0; i < keyPath.length - 1; i++) {
        const key = keyPath[i];
        if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }

      if (keyPath.length > 0) {
        const lastKey = keyPath[keyPath.length - 1];
        const isProviderEnabledToggle = keyPath.length === 1 && lastKey === "enabled";

        if (isProviderEnabledToggle) {
          // Persist only `enabled: false` and delete on enable so providers.jsonc stays minimal.
          if (value === false || value === "false") {
            current[lastKey] = false;
          } else {
            delete current[lastKey];
          }
        } else if (value === undefined) {
          delete current[lastKey];
        } else {
          current[lastKey] = value;
        }
      }

      // Save updated config
      this.config.saveProvidersConfig(providersConfig);
      this.notifyConfigChanged();

      return { success: true, data: undefined };
    } catch (error) {
      const message = getErrorMessage(error);
      return { success: false, error: `Failed to set provider config: ${message}` };
    }
  }

  public setConfig(provider: string, keyPath: string[], value: string): Result<void, string> {
    try {
      // Load current providers config or create empty
      const providersConfig = this.config.loadProvidersConfig() ?? {};

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isProviderAllowed(provider as ProviderName)) {
          return { success: false, error: `Provider ${provider} is not allowed by policy` };
        }

        const forcedBaseUrl = this.policyService.getForcedBaseUrl(provider as ProviderName);
        const isBaseUrlEdit = keyPath.length === 1 && keyPath[0] === "baseUrl";
        if (isBaseUrlEdit && forcedBaseUrl) {
          return { success: false, error: `Provider ${provider} base URL is locked by policy` };
        }
      }

      // Track if this is first time setting couponCode for mux-gateway
      const isFirstMuxGatewayCoupon =
        provider === "mux-gateway" &&
        keyPath.length === 1 &&
        keyPath[0] === "couponCode" &&
        value !== "" &&
        !providersConfig[provider]?.couponCode;

      // Ensure provider exists
      if (!providersConfig[provider]) {
        providersConfig[provider] = {};
      }

      // Set nested property value
      let current = providersConfig[provider] as Record<string, unknown>;
      for (let i = 0; i < keyPath.length - 1; i++) {
        const key = keyPath[i];
        if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }

      if (keyPath.length > 0) {
        const lastKey = keyPath[keyPath.length - 1];
        const isProviderEnabledToggle = keyPath.length === 1 && lastKey === "enabled";

        if (isProviderEnabledToggle) {
          // Persist only `enabled: false` and delete on enable so providers.jsonc stays minimal.
          if (value === "false") {
            current[lastKey] = false;
          } else {
            delete current[lastKey];
          }
        } else if (value === "") {
          // Delete key if value is empty string (used for clearing API keys).
          delete current[lastKey];
        } else {
          current[lastKey] = value;
        }
      }

      // Add default models when setting up mux-gateway for the first time
      if (isFirstMuxGatewayCoupon) {
        const providerConfig = providersConfig[provider] as Record<string, unknown>;
        const existingModels = normalizeProviderModelEntries(providerConfig.models);
        if (existingModels.length === 0) {
          providerConfig.models = [
            "anthropic/claude-sonnet-4-6",
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.2",
            "openai/gpt-5.2-codex",
          ];
        }
      }

      // Save updated config
      this.config.saveProvidersConfig(providersConfig);
      this.notifyConfigChanged();

      return { success: true, data: undefined };
    } catch (error) {
      const message = getErrorMessage(error);
      return { success: false, error: `Failed to set provider config: ${message}` };
    }
  }
}
