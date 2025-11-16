/**
 * Provider factory with lazy loading
 *
 * Creates language model instances for different AI providers. Providers are
 * lazy-loaded on first use to minimize startup time.
 */

/**
 * Configuration for provider creation
 */
export interface ProviderFactoryConfig {
  /** API key for the provider */
  apiKey?: string;
  /** Base URL override for the provider API */
  baseURL?: string;
  /** Custom headers to include in requests */
  headers?: Record<string, string>;
  /** Custom fetch implementation */
  fetch?: typeof fetch;
}
