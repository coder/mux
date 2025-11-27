import type { Config } from "@/node/config";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import type { Result } from "@/common/types/result";

/** AWS credential status for Bedrock provider */
export interface AWSCredentialStatus {
  region?: string;
  bearerTokenSet: boolean;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
}

export interface ProviderConfigInfo {
  apiKeySet: boolean;
  baseUrl?: string;
  models?: string[];
  /** AWS-specific fields (only present for bedrock provider) */
  aws?: AWSCredentialStatus;
}

export type ProvidersConfigMap = Record<string, ProviderConfigInfo>;

export class ProviderService {
  constructor(private readonly config: Config) {}

  public list(): string[] {
    try {
      return [...SUPPORTED_PROVIDERS];
    } catch (error) {
      console.error("Failed to list providers:", error);
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

      // AWS/Bedrock-specific fields
      if (provider === "bedrock") {
        providerInfo.aws = {
          region: config.region,
          bearerTokenSet: !!config.bearerToken,
          accessKeyIdSet: !!config.accessKeyId,
          secretAccessKeySet: !!config.secretAccessKey,
        };
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

      // Save updated config
      this.config.saveProvidersConfig(providersConfig);

      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to set provider config: ${message}` };
    }
  }
}
