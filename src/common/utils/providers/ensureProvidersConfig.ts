import type { Config, ProviderConfig, ProvidersConfig } from "@/node/config";

const trim = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const hasApiKey = (config: ProviderConfig | undefined): boolean =>
  Boolean(config && typeof config.apiKey === "string" && config.apiKey.trim().length > 0);

const hasAnyConfiguredProvider = (providers: ProvidersConfig | null | undefined): boolean => {
  if (!providers) {
    return false;
  }

  return Object.values(providers).some((providerConfig) => hasApiKey(providerConfig));
};

const buildProvidersFromEnv = (env: NodeJS.ProcessEnv): ProvidersConfig => {
  const providers: ProvidersConfig = {};

  // Check ANTHROPIC_API_KEY first, fall back to ANTHROPIC_AUTH_TOKEN
  const anthropicKey = trim(env.ANTHROPIC_API_KEY) || trim(env.ANTHROPIC_AUTH_TOKEN);
  if (anthropicKey.length > 0) {
    const entry: ProviderConfig = { apiKey: anthropicKey };

    const baseUrl = trim(env.ANTHROPIC_BASE_URL);
    if (baseUrl.length > 0) {
      entry.baseUrl = baseUrl;
    }

    providers.anthropic = entry;
  }

  const openAIKey = trim(env.OPENAI_API_KEY);
  if (openAIKey.length > 0) {
    const entry: ProviderConfig = { apiKey: openAIKey };

    const baseUrlCandidates = [env.OPENAI_BASE_URL, env.OPENAI_API_BASE];
    for (const candidate of baseUrlCandidates) {
      const baseUrl = trim(candidate);
      if (baseUrl.length > 0) {
        entry.baseUrl = baseUrl;
        break;
      }
    }

    const organization = trim(env.OPENAI_ORG_ID);
    if (organization.length > 0) {
      entry.organization = organization;
    }

    providers.openai = entry;
  }

  const openRouterKey = trim(env.OPENROUTER_API_KEY);
  if (openRouterKey.length > 0) {
    providers.openrouter = { apiKey: openRouterKey };
  }

  const xaiKey = trim(env.XAI_API_KEY);
  if (xaiKey.length > 0) {
    const entry: ProviderConfig = { apiKey: xaiKey };

    const baseUrl = trim(env.XAI_BASE_URL);
    if (baseUrl.length > 0) {
      entry.baseUrl = baseUrl;
    }

    providers.xai = entry;
  }

  if (!providers.openai) {
    const azureKey = trim(env.AZURE_OPENAI_API_KEY);
    const azureEndpoint = trim(env.AZURE_OPENAI_ENDPOINT);

    if (azureKey.length > 0 && azureEndpoint.length > 0) {
      const entry: ProviderConfig = {
        apiKey: azureKey,
        baseUrl: azureEndpoint,
      };

      const deployment = trim(env.AZURE_OPENAI_DEPLOYMENT);
      if (deployment.length > 0) {
        entry.defaultModel = deployment;
      }

      const apiVersion = trim(env.AZURE_OPENAI_API_VERSION);
      if (apiVersion.length > 0) {
        entry.apiVersion = apiVersion;
      }

      providers.openai = entry;
    }
  }

  const googleKey = trim(env.GOOGLE_API_KEY);
  if (googleKey.length > 0) {
    const entry: ProviderConfig = { apiKey: googleKey };

    const baseUrl = trim(env.GOOGLE_BASE_URL);
    if (baseUrl.length > 0) {
      entry.baseUrl = baseUrl;
    }

    providers.google = entry;
  }

  return providers;
};

export const ensureProvidersConfig = (
  config: Config,
  env: NodeJS.ProcessEnv = process.env
): ProvidersConfig => {
  if (!config) {
    throw new Error("Config instance is required to ensure providers configuration");
  }

  const existingProviders = config.loadProvidersConfig();
  if (hasAnyConfiguredProvider(existingProviders)) {
    if (!existingProviders) {
      throw new Error(
        "Providers config reported configured providers but returned null. Please validate providers.jsonc."
      );
    }
    return existingProviders;
  }

  const providersFromEnv = buildProvidersFromEnv(env);
  if (!hasAnyConfiguredProvider(providersFromEnv)) {
    throw new Error(
      "No provider credentials found. Configure providers.jsonc or set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) / OPENAI_API_KEY / OPENROUTER_API_KEY / GOOGLE_API_KEY."
    );
  }

  config.saveProvidersConfig(providersFromEnv);
  return providersFromEnv;
};
