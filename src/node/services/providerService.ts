import { EventEmitter } from "events";
import type { Config } from "@/node/config";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import type { Result } from "@/common/types/result";
import type {
  AWSCredentialStatus,
  ProviderConfigInfo,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import { log } from "@/node/services/log";

// Re-export types for backward compatibility
export type { AWSCredentialStatus, ProviderConfigInfo, ProvidersConfigMap };

export class ProviderService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly config: Config) {
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

  private emitConfigChanged(): void {
    this.emitter.emit("configChanged");
  }

  public list(): string[] {
    try {
      return [...SUPPORTED_PROVIDERS];
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
    const result: ProvidersConfigMap = {};

    for (const provider of SUPPORTED_PROVIDERS) {
      const config = (providersConfig[provider] ?? {}) as {
        apiKey?: string;
        baseUrl?: string;
        models?: string[];
        serviceTier?: unknown;
        region?: string;
        bearerToken?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
      };

      const providerInfo: ProviderConfigInfo = {
        apiKeySet: !!config.apiKey,
        baseUrl: config.baseUrl,
        models: config.models,
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

      // AWS/Bedrock-specific fields
      if (provider === "bedrock") {
        providerInfo.aws = {
          region: config.region,
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

      result[provider] = providerInfo;
    }

    return result;
  }

  /**
   * Set custom models for a provider
   */
  public setModels(provider: string, models: string[]): Result<void, string> {
    try {
      const providersConfig = this.config.loadProvidersConfig() ?? {};

      if (!providersConfig[provider]) {
        providersConfig[provider] = {};
      }

      providersConfig[provider].models = models;
      this.config.saveProvidersConfig(providersConfig);
      this.emitConfigChanged();

      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to set models: ${message}` };
    }
  }

  public setConfig(provider: string, keyPath: string[], value: string): Result<void, string> {
    try {
      // Load current providers config or create empty
      const providersConfig = this.config.loadProvidersConfig() ?? {};

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
        // Delete key if value is empty string (used for clearing API keys), otherwise set it
        if (value === "") {
          delete current[lastKey];
        } else {
          current[lastKey] = value;
        }
      }

      // Add default models when setting up mux-gateway for the first time
      if (isFirstMuxGatewayCoupon) {
        const providerConfig = providersConfig[provider] as Record<string, unknown>;
        if (!providerConfig.models || (providerConfig.models as string[]).length === 0) {
          providerConfig.models = [
            "anthropic/claude-sonnet-4-5",
            "anthropic/claude-opus-4-5",
            "openai/gpt-5.2",
            "openai/gpt-5.1-codex",
          ];
        }
      }

      // Save updated config
      this.config.saveProvidersConfig(providersConfig);
      this.emitConfigChanged();

      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to set provider config: ${message}` };
    }
  }
}
