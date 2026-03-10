/**
 * Provider Definitions - Single source of truth for all provider metadata
 *
 * When adding a new provider:
 * 1. Add entry to PROVIDER_DEFINITIONS below
 * 2. Add SVG icon + import in src/browser/components/ProviderIcon.tsx
 * 3. If provider needs custom logic, add handler in aiService.ts
 *    (simple providers using standard pattern are handled automatically)
 *
 * Simple providers (requiresApiKey + standard factory pattern) need NO aiService.ts changes.
 */

/**
 * Union type of all supported provider names
 */
export type ProviderName =
  | "mux-gateway"
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "openrouter"
  | "github-copilot"
  | "bedrock"
  | "ollama";

interface ProviderDefinition {
  /** Display name for UI (proper casing) */
  displayName: string;
  /** Dynamic import function for lazy loading */
  import: () => Promise<unknown>;
  /** Name of the factory function exported by the package */
  factoryName: string;
  /** Whether provider requires an API key (false for local services like Ollama) */
  requiresApiKey: boolean;
  /** Provider category for routing behavior */
  kind: "direct" | "gateway" | "local";
  /** Gateways only: which direct providers this gateway routes to */
  routes?: ProviderName[];
  /** Transform canonical model identity into a gateway-specific model ID */
  toGatewayModelId?: (origin: string, modelId: string) => string;
  /** Parse a gateway-specific model ID back into canonical model identity */
  fromGatewayModelId?: (gatewayModelId: string) => { origin: string; modelId: string } | null;
  /** True when gateway is a transparent proxy and preserves canonical identity */
  passthrough?: boolean;
  /** Whether this provider uses stroke-based icon styling instead of fill */
  strokeBasedIcon?: boolean;
}

const toSlashSeparatedGatewayModelId = (origin: string, modelId: string): string =>
  `${origin}/${modelId}`;

const fromSlashSeparatedGatewayModelId = (
  gatewayModelId: string
): { origin: string; modelId: string } | null => {
  const separatorIndex = gatewayModelId.indexOf("/");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    origin: gatewayModelId.slice(0, separatorIndex),
    modelId: gatewayModelId.slice(separatorIndex + 1),
  };
};

// Order determines display order in UI (Settings, model selectors, etc.)
export const PROVIDER_DEFINITIONS = {
  "mux-gateway": {
    displayName: "Mux Gateway",
    import: () => import("ai"),
    factoryName: "createGateway",
    requiresApiKey: true, // Uses couponCode
    kind: "gateway",
    routes: ["anthropic", "openai", "google", "xai"],
    passthrough: true,
    toGatewayModelId: toSlashSeparatedGatewayModelId,
    fromGatewayModelId: fromSlashSeparatedGatewayModelId,
    strokeBasedIcon: true,
  },
  anthropic: {
    displayName: "Anthropic",
    import: () => import("@ai-sdk/anthropic"),
    factoryName: "createAnthropic",
    requiresApiKey: true,
    kind: "direct",
  },
  openai: {
    displayName: "OpenAI",
    import: () => import("@ai-sdk/openai"),
    factoryName: "createOpenAI",
    requiresApiKey: true,
    kind: "direct",
  },
  google: {
    displayName: "Google",
    import: () => import("@ai-sdk/google"),
    factoryName: "createGoogleGenerativeAI",
    requiresApiKey: true,
    kind: "direct",
  },
  xai: {
    displayName: "xAI",
    import: () => import("@ai-sdk/xai"),
    factoryName: "createXai",
    requiresApiKey: true,
    kind: "direct",
  },
  deepseek: {
    displayName: "DeepSeek",
    import: () => import("@ai-sdk/deepseek"),
    factoryName: "createDeepSeek",
    requiresApiKey: true,
    kind: "direct",
  },
  openrouter: {
    displayName: "OpenRouter",
    import: () => import("@openrouter/ai-sdk-provider"),
    factoryName: "createOpenRouter",
    requiresApiKey: true,
    kind: "gateway",
    routes: ["anthropic", "openai", "google", "xai", "deepseek"],
    passthrough: false,
    toGatewayModelId: toSlashSeparatedGatewayModelId,
    fromGatewayModelId: fromSlashSeparatedGatewayModelId,
  },
  "github-copilot": {
    displayName: "GitHub Copilot",
    import: () => import("@ai-sdk/openai-compatible"),
    factoryName: "createOpenAICompatible",
    requiresApiKey: true,
    kind: "gateway",
    routes: ["openai"],
    passthrough: false,
    // Copilot's OpenAI-compatible API accepts raw upstream model IDs for routed OpenAI traffic.
    // Intentionally omit fromGatewayModelId: github-copilot:* model strings are canonical identities
    // with Copilot-specific pricing/capabilities, including non-OpenAI families like Claude.
    toGatewayModelId: (_origin, modelId) => modelId,
  },
  bedrock: {
    displayName: "Bedrock",
    import: () => import("@ai-sdk/amazon-bedrock"),
    factoryName: "createAmazonBedrock",
    requiresApiKey: false, // Uses AWS credential chain
    kind: "gateway",
    routes: ["anthropic"],
    passthrough: false,
  },
  ollama: {
    displayName: "Ollama",
    import: () => import("ollama-ai-provider-v2"),
    factoryName: "createOllama",
    requiresApiKey: false, // Local service
    kind: "local",
  },
} as const satisfies Record<ProviderName, ProviderDefinition>;

export const GATEWAY_PROVIDERS = Object.entries(PROVIDER_DEFINITIONS)
  .filter(([, def]) => def.kind === "gateway")
  .map(([name]) => name as ProviderName);

export const DIRECT_PROVIDERS = Object.entries(PROVIDER_DEFINITIONS)
  .filter(([, def]) => def.kind === "direct")
  .map(([name]) => name as ProviderName);

/** Which gateways can route a given origin? */
export function gatewaysForOrigin(origin: ProviderName): ProviderName[] {
  return GATEWAY_PROVIDERS.filter((gateway) => {
    const gatewayDefinition = PROVIDER_DEFINITIONS[gateway] as ProviderDefinition;
    return gatewayDefinition.routes?.includes(origin);
  });
}

/**
 * Array of all supported provider names (for UI lists, iteration, etc.)
 */
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS) as ProviderName[];

/**
 * Display names for providers (proper casing for UI)
 * Derived from PROVIDER_DEFINITIONS - do not edit directly
 */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = Object.fromEntries(
  Object.entries(PROVIDER_DEFINITIONS).map(([key, def]) => [key, def.displayName])
) as Record<ProviderName, string>;

/**
 * Legacy registry for backward compatibility with aiService.ts
 * Maps provider names to their import functions
 */
export const PROVIDER_REGISTRY = Object.fromEntries(
  Object.entries(PROVIDER_DEFINITIONS).map(([key, def]) => [key, def.import])
) as { [K in ProviderName]: (typeof PROVIDER_DEFINITIONS)[K]["import"] };

/**
 * Type guard to check if a string is a valid provider name
 */
export function isValidProvider(provider: string): provider is ProviderName {
  return provider in PROVIDER_REGISTRY;
}
