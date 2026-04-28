import { EventEmitter } from "events";
import type { Config, ProjectsConfig } from "@/node/config";
import {
  PROVIDER_DEFINITIONS,
  SUPPORTED_PROVIDERS,
  type ProviderName,
} from "@/common/constants/providers";
import type { BaseProviderConfig } from "@/common/config/schemas/providersConfig";
import type { Result } from "@/common/types/result";
import type {
  AddCustomOpenAICompatibleProviderInput,
  AWSCredentialStatus,
  CustomProviderMutationError,
  ProviderConfigInfo,
  ProviderModelEntry,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import { modelStringStartsWithProvider } from "@/common/utils/providers/modelString";
import { resolveConfigBaseUrl } from "@/common/utils/providers/baseUrl";
import {
  getCustomOpenAICompatibleProviderIds,
  getShadowedCustomOpenAICompatibleProviderIds,
  isBuiltInProvider,
  isCustomOpenAICompatibleProviderConfig,
  validateCustomProviderId,
  type ProvidersConfigWithProviderType,
} from "@/common/utils/providers/customProviders";
import { isOpReference } from "@/common/utils/opRef";
import {
  getProviderModelEntryId,
  normalizeProviderModelEntries,
} from "@/common/utils/providers/modelEntries";
import { log } from "@/node/services/log";
import {
  checkProviderConfigured,
  isProviderAutoRouteEligible,
  resolveProviderCredentials,
} from "@/node/utils/providerRequirements";
import { parseCodexOauthAuth } from "@/node/utils/codexOauthAuth";
import type { PolicyService } from "@/node/services/policyService";
import { getErrorMessage } from "@/common/utils/errors";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

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

function buildCustomProviderConfigInfo(
  config: BaseProviderConfig,
  policy?: { forcedBaseUrl?: string; allowedModels?: string[] | null }
): ProviderConfigInfo {
  const baseUrl = policy?.forcedBaseUrl ?? resolveConfigBaseUrl(config);
  const models = filterProviderModelsByPolicy(
    normalizeProviderModelEntries(config.models),
    policy?.allowedModels ?? null
  );
  const apiKeyIsOpRef = isOpReference(config.apiKey);
  const apiKeySet = typeof config.apiKey === "string" && config.apiKey.trim().length > 0;
  const apiKeyFile = typeof config.apiKeyFile === "string" ? config.apiKeyFile : undefined;
  const isEnabled = !isProviderDisabledInConfig(config);

  return {
    apiKeySet,
    apiKeyIsOpRef: apiKeyIsOpRef || undefined,
    apiKeyOpRef: apiKeyIsOpRef ? config.apiKey : undefined,
    apiKeyOpLabel: apiKeyIsOpRef ? config.apiKeyOpLabel : undefined,
    apiKeyFile,
    apiKeySource: apiKeySet ? "config" : apiKeyFile ? "file" : "keyless",
    baseUrl,
    models,
    displayName: config.displayName,
    providerType: "openai-compatible",
    isCustom: true,
    isEnabled,
    isConfigured: isEnabled && baseUrl !== undefined,
  };
}

const DENIED_KEY_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

type CustomProviderMutationResult<T> = Result<T, CustomProviderMutationError>;

interface ProviderPolicy {
  forcedBaseUrl?: string;
  allowedModels?: string[] | null;
}

function addErrorReason<T extends CustomProviderMutationError>(
  error: T,
  reason: string | undefined
): T {
  if (reason === undefined) {
    return error;
  }

  return { ...error, reason };
}

function isValidHttpBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getProviderConfigRecord(config: unknown): Record<string, BaseProviderConfig> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {};
  }

  return config as Record<string, BaseProviderConfig>;
}

export class ProviderService {
  private readonly policyService: PolicyService | null;
  private readonly emitter = new EventEmitter();
  private lastWarnedShadowedCustomProviderIds: Set<string> | null = null;

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
    this.lastWarnedShadowedCustomProviderIds = null;
    this.emitter.emit("configChanged");
  }

  private listBuiltInProviders(): ProviderName[] {
    const providers = [...SUPPORTED_PROVIDERS];

    if (this.policyService?.isEnforced()) {
      return providers.filter((p) => this.policyService!.isProviderAllowed(p));
    }

    return providers;
  }

  private hasSameWarnedShadowedProviderIds(shadowedProviderIds: Set<string>): boolean {
    if (this.lastWarnedShadowedCustomProviderIds === null) {
      return false;
    }

    if (this.lastWarnedShadowedCustomProviderIds.size !== shadowedProviderIds.size) {
      return false;
    }

    for (const providerId of shadowedProviderIds) {
      if (!this.lastWarnedShadowedCustomProviderIds.has(providerId)) {
        return false;
      }
    }

    return true;
  }

  private detectAndLogShadowedProviders(
    providersConfig: ProvidersConfigWithProviderType
  ): Set<string> {
    const shadowedProviderIds = new Set(
      getShadowedCustomOpenAICompatibleProviderIds(providersConfig)
    );

    // list() and getConfig() can run during one UI render, so remember the
    // last detected shadow set to avoid duplicate warning noise for that cycle.
    if (
      shadowedProviderIds.size > 0 &&
      !this.hasSameWarnedShadowedProviderIds(shadowedProviderIds)
    ) {
      log.warn(
        `Custom provider ids shadow built-in providers and will keep using custom config: ${Array.from(
          shadowedProviderIds
        )
          .sort()
          .join(", ")}`
      );
    }

    this.lastWarnedShadowedCustomProviderIds = shadowedProviderIds;
    return shadowedProviderIds;
  }

  public list(): string[] {
    try {
      const providers = this.listBuiltInProviders();
      const providersConfig = this.config.loadProvidersConfig() ?? {};
      const customProviderIds = getCustomOpenAICompatibleProviderIds(providersConfig);
      this.detectAndLogShadowedProviders(providersConfig);
      const allowedCustomProviderIds = this.policyService?.isEnforced()
        ? customProviderIds.filter((p) => this.policyService?.isProviderAllowed(p) ?? false)
        : customProviderIds;
      return Array.from(new Set([...providers, ...allowedCustomProviderIds]));
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
    const shadowedCustomProviderIds = this.detectAndLogShadowedProviders(providersConfig);

    for (const provider of this.listBuiltInProviders()) {
      if (shadowedCustomProviderIds.has(provider)) {
        continue;
      }
      const config = (providersConfig[provider] ?? {}) as {
        apiKey?: string;
        apiKeyFile?: string;
        apiKeyOpLabel?: string;
        baseUrl?: string;
        baseURL?: string;
        models?: unknown[];
        serviceTier?: string;
        wireFormat?: string;
        store?: unknown;
        cacheTtl?: unknown;
        disableBetaFeatures?: unknown;
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
      const apiKeyIsOpRef = isOpReference(config.apiKey);
      let isEnabled = !isProviderDisabledInConfig(config);
      if (provider === "mux-gateway" && mainConfig.muxGatewayEnabled === false) {
        isEnabled = false;
      }

      const explicitBaseUrl = resolveConfigBaseUrl(config);

      const providerInfo: ProviderConfigInfo = {
        apiKeySet: !!config.apiKey,
        apiKeyIsOpRef: apiKeyIsOpRef || undefined,
        apiKeyOpRef: apiKeyIsOpRef ? config.apiKey : undefined,
        apiKeyOpLabel: apiKeyIsOpRef ? config.apiKeyOpLabel : undefined,
        // Users can disable providers without removing credentials from providers.jsonc.
        isEnabled,
        isConfigured: false, // computed below
        baseUrl: forcedBaseUrl ?? explicitBaseUrl,
        apiKeyFile: typeof config.apiKeyFile === "string" ? config.apiKeyFile : undefined,
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

      // OpenAI-specific: wire format (responses vs chatCompletions)
      const wireFormat = config.wireFormat;
      if (
        provider === "openai" &&
        (wireFormat === "responses" || wireFormat === "chatCompletions")
      ) {
        providerInfo.wireFormat = wireFormat;
      }

      // OpenAI-specific: response storage setting (required for ZDR)
      if (provider === "openai" && typeof config.store === "boolean") {
        providerInfo.store = config.store;
      }

      // Anthropic-specific fields
      const cacheTtl = config.cacheTtl;
      if (provider === "anthropic" && (cacheTtl === "5m" || cacheTtl === "1h")) {
        providerInfo.cacheTtl = cacheTtl;
      }

      // Anthropic-specific: disable all beta features for ZDR orgs.
      if (provider === "anthropic" && config.disableBetaFeatures === true) {
        providerInfo.disableBetaFeatures = true;
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

      // Mux Gateway-specific fields (check couponCode first, fallback to legacy voucher).
      // Gateway stores enabled/models in the global config (~/.mux/config.json), not
      // in providers.jsonc, so override the generic isEnabled with the gateway-specific value.
      if (provider === "mux-gateway") {
        const muxConfig = config as { couponCode?: string; voucher?: string };
        providerInfo.couponCodeSet = !!(muxConfig.couponCode ?? muxConfig.voucher);
        const globalConfig = this.config.loadConfigOrDefault();
        providerInfo.isEnabled = globalConfig.muxGatewayEnabled !== false;
        providerInfo.gatewayModels = globalConfig.muxGatewayModels ?? [];
      }

      // Compute isConfigured using shared utility (checks config + env vars).
      // Disabled providers intentionally surface as not configured in the UI.
      // Use providerInfo.isEnabled (not the local `isEnabled`) because gateway
      // overrides it from global config — using the providers.jsonc value would
      // make a disabled gateway appear configured.
      const configCheck = checkProviderConfigured(provider, config);
      providerInfo.isConfigured = providerInfo.isEnabled && configCheck.isConfigured;
      providerInfo.apiKeySource = configCheck.apiKeySource;
      if (forcedBaseUrl === undefined && configCheck.baseUrlSource && configCheck.baseUrlResolved) {
        providerInfo.baseUrlSource = configCheck.baseUrlSource;
        providerInfo.baseUrlResolved = configCheck.baseUrlResolved;
      }

      if (provider === "openai" && isEnabled && codexOauthSet) {
        providerInfo.isConfigured = true;
      }

      result[provider] = providerInfo;
    }

    for (const providerId of getCustomOpenAICompatibleProviderIds(providersConfig)) {
      const providerConfig = providersConfig[providerId];
      if (!isCustomOpenAICompatibleProviderConfig(providerConfig)) {
        continue;
      }

      if (this.policyService?.isEnforced() && !this.policyService.isProviderAllowed(providerId)) {
        continue;
      }

      const providerPolicy = this.policyService?.isEnforced()
        ? this.policyService.getEffectivePolicy()?.providerAccess?.find((p) => p.id === providerId)
        : undefined;

      result[providerId] = buildCustomProviderConfigInfo(providerConfig, {
        forcedBaseUrl: providerPolicy?.forcedBaseUrl,
        allowedModels: providerPolicy?.allowedModels ?? null,
      });
    }

    return result;
  }

  private getProviderPolicy(provider: string): ProviderPolicy {
    if (!this.policyService?.isEnforced()) {
      return {};
    }

    const providerPolicy = this.policyService
      .getEffectivePolicy()
      ?.providerAccess?.find((entry) => entry.id === provider);
    return {
      forcedBaseUrl: providerPolicy?.forcedBaseUrl,
      allowedModels: providerPolicy?.allowedModels ?? null,
    };
  }

  private getPolicyDeniedError(message: string, reason?: string): CustomProviderMutationError {
    return addErrorReason({ code: "policy_denied", message }, reason);
  }

  private getDisallowedModelsByPolicy(provider: string, models: ProviderModelEntry[]): string[] {
    if (!this.policyService?.isEnforced()) {
      return [];
    }

    const allowedModels = this.getProviderPolicy(provider).allowedModels ?? null;
    if (!Array.isArray(allowedModels)) {
      return [];
    }

    return models
      .map((entry) => getProviderModelEntryId(entry))
      .filter((modelId) => !allowedModels.includes(modelId));
  }

  public addCustomOpenAICompatibleProvider(
    input: AddCustomOpenAICompatibleProviderInput
  ): CustomProviderMutationResult<ProviderConfigInfo> {
    const provider = input.provider.trim();
    if (isBuiltInProvider(provider)) {
      return {
        success: false,
        error: {
          code: "built_in_provider",
          message: `Provider ${provider} is built in and cannot be added as custom.`,
        },
      };
    }

    const validation = validateCustomProviderId(provider);
    if (!validation.ok) {
      return {
        success: false,
        error: addErrorReason(
          { code: "invalid_provider_id", message: "Invalid custom provider id." },
          validation.reason
        ),
      };
    }

    const baseUrl = input.baseUrl.trim();

    try {
      const providersConfig = getProviderConfigRecord(this.config.loadProvidersConfig() ?? {});
      if (Object.hasOwn(providersConfig, provider)) {
        return {
          success: false,
          error: {
            code: "duplicate_provider",
            message: `Provider ${provider} already exists in providers config.`,
          },
        };
      }

      if (!baseUrl || !isValidHttpBaseUrl(baseUrl)) {
        return {
          success: false,
          error: {
            code: "invalid_base_url",
            message: "Custom OpenAI-compatible providers require an HTTP or HTTPS base URL.",
          },
        };
      }

      if (this.policyService?.isEnforced() && !this.policyService.isProviderAllowed(provider)) {
        return {
          success: false,
          error: this.getPolicyDeniedError(`Provider ${provider} is not allowed by policy.`),
        };
      }

      const providerPolicy = this.getProviderPolicy(provider);
      const persistedBaseUrl = providerPolicy.forcedBaseUrl ?? baseUrl;
      if (providerPolicy.forcedBaseUrl && baseUrl !== providerPolicy.forcedBaseUrl) {
        return {
          success: false,
          error: this.getPolicyDeniedError(
            `Provider ${provider} base URL is locked by policy.`,
            `Expected ${providerPolicy.forcedBaseUrl}.`
          ),
        };
      }

      const normalizedModels = normalizeProviderModelEntries(input.models);
      const disallowedModels = this.getDisallowedModelsByPolicy(provider, normalizedModels);
      if (disallowedModels.length > 0) {
        return {
          success: false,
          error: this.getPolicyDeniedError(
            `One or more models are not allowed by policy: ${disallowedModels.join(", ")}`
          ),
        };
      }

      const displayName = input.displayName?.trim();
      const apiKey = input.apiKey?.trim();
      const apiKeyFile = input.apiKeyFile?.trim();
      const providerConfig: BaseProviderConfig = {
        providerType: "openai-compatible",
        baseUrl: persistedBaseUrl,
        enabled: true,
        ...(displayName ? { displayName } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(apiKeyFile ? { apiKeyFile } : {}),
        ...(normalizedModels.length > 0 ? { models: normalizedModels } : {}),
      };

      providersConfig[provider] = providerConfig;
      this.config.saveProvidersConfig(providersConfig);

      const providerInfo = this.getConfig()[provider];
      if (!providerInfo) {
        return {
          success: false,
          error: {
            code: "persistence_failed",
            message: `Provider ${provider} was saved but could not be reloaded.`,
          },
        };
      }

      this.notifyConfigChanged();
      return { success: true, data: providerInfo };
    } catch (error) {
      return {
        success: false,
        error: addErrorReason(
          { code: "persistence_failed", message: `Failed to add provider ${provider}.` },
          getErrorMessage(error)
        ),
      };
    }
  }

  public async removeCustomProvider(
    providerInput: string
  ): Promise<CustomProviderMutationResult<void>> {
    const provider = providerInput.trim();
    const providersConfig = getProviderConfigRecord(this.config.loadProvidersConfig() ?? {});
    const providerConfig = providersConfig[provider];
    // Manual providers.jsonc edits can shadow a built-in id. Removing that entry
    // restores the built-in default, so only reject bona fide built-in configs.
    const isShadowedCustomProvider =
      isBuiltInProvider(provider) && isCustomOpenAICompatibleProviderConfig(providerConfig);

    if (isBuiltInProvider(provider) && !isShadowedCustomProvider) {
      return {
        success: false,
        error: {
          code: "built_in_provider",
          message: `Provider ${provider} is built in and cannot be removed as custom.`,
        },
      };
    }

    if (!isShadowedCustomProvider) {
      const validation = validateCustomProviderId(provider);
      if (!validation.ok) {
        return {
          success: false,
          error: addErrorReason(
            { code: "invalid_provider_id", message: "Invalid custom provider id." },
            validation.reason
          ),
        };
      }
    }

    if (!Object.hasOwn(providersConfig, provider)) {
      return {
        success: false,
        error: { code: "unknown_provider", message: `Provider ${provider} does not exist.` },
      };
    }

    if (!isCustomOpenAICompatibleProviderConfig(providersConfig[provider])) {
      return {
        success: false,
        error: {
          code: "not_custom_provider",
          message: `Provider ${provider} is not a custom OpenAI-compatible provider.`,
        },
      };
    }

    try {
      const latestProvidersConfig = getProviderConfigRecord(
        this.config.loadProvidersConfig() ?? {}
      );
      if (!isCustomOpenAICompatibleProviderConfig(latestProvidersConfig[provider])) {
        return {
          success: false,
          error: {
            code: "not_custom_provider",
            message: `Provider ${provider} is not a custom OpenAI-compatible provider.`,
          },
        };
      }

      delete latestProvidersConfig[provider];
      this.config.saveProvidersConfig(latestProvidersConfig);
    } catch (error) {
      return {
        success: false,
        error: addErrorReason(
          { code: "persistence_failed", message: `Failed to remove provider ${provider}.` },
          getErrorMessage(error)
        ),
      };
    }

    try {
      await this.config.editConfig((config) =>
        this.repairRemovedCustomProviderReferences(config, provider)
      );
    } catch (error) {
      // The provider is already deleted from providers.jsonc. Notify subscribers so they
      // re-sync even when durable model reference cleanup needs another attempt.
      this.notifyConfigChanged();
      return {
        success: false,
        error: addErrorReason(
          {
            code: "config_repair_failed",
            message: `Provider ${provider} was removed, but saved model references could not be repaired.`,
          },
          getErrorMessage(error)
        ),
      };
    }

    this.notifyConfigChanged();
    return { success: true, data: undefined };
  }

  private repairRemovedCustomProviderReferences(
    config: ProjectsConfig,
    provider: string
  ): ProjectsConfig {
    // Removing a custom provider also clears durable model references so stale provider ids
    // do not become invalid app or workspace defaults on the next startup.
    if (modelStringStartsWithProvider(config.defaultModel, provider)) {
      delete config.defaultModel;
    }

    if (config.hiddenModels) {
      const hiddenModels = config.hiddenModels.filter(
        (modelString) => !modelStringStartsWithProvider(modelString, provider)
      );
      if (hiddenModels.length > 0) {
        config.hiddenModels = hiddenModels;
      } else {
        delete config.hiddenModels;
      }
    }

    if (config.routeOverrides) {
      const routeOverrides = Object.fromEntries(
        Object.entries(config.routeOverrides).filter(
          ([modelString, routeTarget]) =>
            !modelStringStartsWithProvider(modelString, provider) && routeTarget !== provider
        )
      );
      if (Object.keys(routeOverrides).length > 0) {
        config.routeOverrides = routeOverrides;
      } else {
        delete config.routeOverrides;
      }
    }

    if (config.agentAiDefaults) {
      for (const entry of Object.values(config.agentAiDefaults)) {
        if (modelStringStartsWithProvider(entry.modelString, provider)) {
          delete entry.modelString;
        }
      }
    }

    if (config.subagentAiDefaults) {
      for (const entry of Object.values(config.subagentAiDefaults)) {
        if (modelStringStartsWithProvider(entry.modelString, provider)) {
          delete entry.modelString;
        }
      }
    }

    for (const projectConfig of config.projects.values()) {
      for (const workspace of projectConfig.workspaces) {
        if (
          workspace.aiSettings &&
          modelStringStartsWithProvider(workspace.aiSettings.model, provider)
        ) {
          workspace.aiSettings = {
            ...workspace.aiSettings,
            model: WORKSPACE_DEFAULTS.model,
          };
        }

        if (workspace.aiSettingsByAgent) {
          for (const [agentId, settings] of Object.entries(workspace.aiSettingsByAgent)) {
            if (modelStringStartsWithProvider(settings.model, provider)) {
              workspace.aiSettingsByAgent[agentId] = {
                ...settings,
                model: WORKSPACE_DEFAULTS.model,
              };
            }
          }
        }
      }
    }

    return config;
  }

  /**
   * Set custom models for a provider
   */
  public setModels(provider: string, models: ProviderModelEntry[]): Result<void, string> {
    try {
      const normalizedModels = normalizeProviderModelEntries(models);

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isProviderAllowed(provider)) {
          return { success: false, error: `Provider ${provider} is not allowed by policy` };
        }

        const allowedModels =
          this.policyService.getEffectivePolicy()?.providerAccess?.find((p) => p.id === provider)
            ?.allowedModels ?? null;

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
   * After a credential change, sync gateway presence in routePriority.
   * Configured gateways auto-insert immediately before "direct" in routePriority,
   * preserving existing user-defined order.
   * Gateways that are explicitly disabled or fully deconfigured are removed;
   * configured-but-not-auto-eligible gateways keep any manual route.
   */
  private async syncGatewayLifecycle(provider: string): Promise<void> {
    if (!(provider in PROVIDER_DEFINITIONS)) return;
    const providerName = provider as ProviderName;
    const def = PROVIDER_DEFINITIONS[providerName];
    if (def.kind !== "gateway") return;

    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const isAutoRouteEligible = isProviderAutoRouteEligible(
      providerName,
      providersConfig[providerName] ?? {}
    );
    const config = this.config.loadConfigOrDefault();
    const priority = config.routePriority ?? ["direct"];

    if (isAutoRouteEligible && !priority.includes(providerName)) {
      // Insert before "direct" to stay reachable while preserving the
      // relative order of any user-configured routes already present.
      const directIndex = priority.indexOf("direct");
      const insertIndex = directIndex === -1 ? priority.length : directIndex;
      const nextPriority = [...priority];
      nextPriority.splice(insertIndex, 0, providerName);
      await this.config.editConfig((c) => ({
        ...c,
        routePriority: nextPriority,
        // Clear legacy disable — routePriority presence is now the authoritative
        // routing signal, so a stale muxGatewayEnabled: false must not veto it.
        ...(providerName === "mux-gateway" ? { muxGatewayEnabled: undefined } : {}),
      }));
    } else if (!isAutoRouteEligible && priority.includes(providerName)) {
      // Only remove a gateway from routePriority when it is truly deconfigured
      // or explicitly disabled. Configured-but-not-auto-eligible providers
      // (e.g., Bedrock with IAM role auth that has no observable credentials)
      // should keep any manually added route.
      const providerConfig = providersConfig[providerName] ?? {};
      const credentials = resolveProviderCredentials(providerName, providerConfig);
      const shouldRemove = !credentials.isConfigured || isProviderDisabledInConfig(providerConfig);
      if (shouldRemove) {
        await this.config.editConfig((c) => ({
          ...c,
          routePriority: priority.filter((p) => p !== providerName),
        }));
      }
    }
  }

  /**
   * Set provider config values that aren't representable as strings.
   *
   * Intended for persisted auth blobs (e.g. Codex OAuth tokens) that should never
   * cross the frontend boundary.
   */
  public async setConfigValue(
    provider: string,
    keyPath: string[],
    value: unknown
  ): Promise<Result<void, string>> {
    const deniedSegment = keyPath.find((segment) => DENIED_KEY_PATH_SEGMENTS.has(segment));
    if (deniedSegment) {
      // Match the agentic config mutation path so legacy ORPC callers cannot write into prototypes.
      return { success: false, error: `Denied key path segment: "${deniedSegment}"` };
    }

    try {
      // Load current providers config or create empty
      const providersConfig = this.config.loadProvidersConfig() ?? {};

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isProviderAllowed(provider)) {
          return { success: false, error: `Provider ${provider} is not allowed by policy` };
        }

        const forcedBaseUrl = this.policyService.getForcedBaseUrl(provider);
        const isBaseUrlEdit =
          keyPath.length === 1 && (keyPath[0] === "baseUrl" || keyPath[0] === "baseURL");
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
      await this.syncGatewayLifecycle(provider);

      return { success: true, data: undefined };
    } catch (error) {
      const message = getErrorMessage(error);
      return { success: false, error: `Failed to set provider config: ${message}` };
    }
  }

  public async setConfig(
    provider: string,
    keyPath: string[],
    value: string | boolean
  ): Promise<Result<void, string>> {
    const deniedSegment = keyPath.find((segment) => DENIED_KEY_PATH_SEGMENTS.has(segment));
    if (deniedSegment) {
      // Match the agentic config mutation path so legacy ORPC callers cannot write into prototypes.
      return { success: false, error: `Denied key path segment: "${deniedSegment}"` };
    }

    try {
      // Load current providers config or create empty
      const providersConfig = this.config.loadProvidersConfig() ?? {};

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isProviderAllowed(provider)) {
          return { success: false, error: `Provider ${provider} is not allowed by policy` };
        }

        const forcedBaseUrl = this.policyService.getForcedBaseUrl(provider);
        const isBaseUrlEdit =
          keyPath.length === 1 && (keyPath[0] === "baseUrl" || keyPath[0] === "baseURL");
        if (isBaseUrlEdit && forcedBaseUrl) {
          return { success: false, error: `Provider ${provider} base URL is locked by policy` };
        }
      }

      const isOpenAICompatibleProviderTypeEdit =
        keyPath.length === 1 && keyPath[0] === "providerType" && value === "openai-compatible";
      if (isOpenAICompatibleProviderTypeEdit) {
        const validation = validateCustomProviderId(provider);
        if (!validation.ok) {
          return { success: false, error: `Invalid custom provider id: ${validation.reason}` };
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
        const isCanonicalBaseUrlEdit = keyPath.length === 1 && lastKey === "baseUrl";
        if (isCanonicalBaseUrlEdit) {
          // The UI writes `baseUrl`. Remove the SDK-style alias so old `baseURL`
          // values cannot keep shadowing user edits or clears after save.
          delete current.baseURL;
        }

        if (isProviderEnabledToggle) {
          // Persist only `enabled: false` and delete on enable so providers.jsonc stays minimal.
          if (value === false || value === "false") {
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
            "anthropic/claude-opus-4-7",
            "openai/gpt-5.5",
          ];
        }
      }

      // Save updated config
      this.config.saveProvidersConfig(providersConfig);
      this.notifyConfigChanged();
      await this.syncGatewayLifecycle(provider);

      return { success: true, data: undefined };
    } catch (error) {
      const message = getErrorMessage(error);
      return { success: false, error: `Failed to set provider config: ${message}` };
    }
  }

  public validateRouteOverrides(routeOverrides: Record<string, string>): Result<void, string> {
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    for (const routeTarget of Object.values(routeOverrides)) {
      const targetConfig = providersConfig[routeTarget];
      if (isCustomOpenAICompatibleProviderConfig(targetConfig)) {
        return {
          success: false,
          error: `Custom providers are direct-only and cannot be the target of a routeOverride: ${routeTarget}.`,
        };
      }
    }

    return { success: true, data: undefined };
  }
}
