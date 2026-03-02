/**
 * GitHub Copilot helpers — shared between standard and enterprise providers.
 *
 * Extracted so they can be unit-tested independently of the OAuth service.
 */

/** Strip protocol prefix and trailing slash from a domain string. */
export function normalizeDomain(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Build the OAuth Device Code and Access Token URLs for a given domain. */
export function getOauthUrls(domain: string): {
  deviceCodeUrl: string;
  accessTokenUrl: string;
} {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  };
}

/** Return the Copilot API base URL — public API for github.com, copilot-api subdomain for enterprise. */
export function getCopilotApiBaseUrl(domain?: string): string {
  if (!domain || domain === "github.com") {
    return "https://api.githubcopilot.com";
  }
  return `https://copilot-api.${domain}`;
}

/**
 * Whether the given model should use the Responses API instead of Chat Completions.
 * GPT-5+ (except gpt-5-mini variants) use the Responses API.
 */
export function shouldUseCopilotResponsesApi(modelId: string): boolean {
  const match = /^gpt-(\d+)/.exec(modelId);
  if (!match) return false;
  if (modelId.startsWith("gpt-5-mini")) return false;
  return Number(match[1]) >= 5;
}

/**
 * Inspect a Copilot request body to determine initiator and vision headers.
 *
 * - `isAgent`: true when the last message role is "assistant" or "tool"
 *   (agent-initiated continuation), false for "user" (user-initiated).
 * - `hasVision`: true when any message contains an image content part
 *   (Chat API: `image_url` type, Responses API: `input_image` type).
 */
export function detectCopilotRequestContext(body: string | null): {
  isAgent: boolean;
  hasVision: boolean;
} {
  const defaults = { isAgent: false, hasVision: false };
  if (!body) return defaults;

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;

    let isAgent = false;
    let hasVision = false;

    // Chat Completions API: { messages: [...] }
    const messages = parsed.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const last = messages[messages.length - 1] as { role?: string };
      isAgent = last?.role === "assistant" || last?.role === "tool";

      // Scan for image content parts
      hasVision = messages.some((msg: { content?: unknown }) => {
        if (!Array.isArray(msg.content)) return false;
        return (msg.content as Array<{ type?: string }>).some((part) => part.type === "image_url");
      });
    }

    // Responses API: { input: [...] }
    const input = parsed.input;
    if (Array.isArray(input) && input.length > 0) {
      const last = input[input.length - 1] as { role?: string };
      isAgent = last?.role === "assistant" || last?.role === "tool";

      hasVision = input.some((item: { content?: unknown }) => {
        if (!Array.isArray(item.content)) return false;
        return (item.content as Array<{ type?: string }>).some(
          (part) => part.type === "input_image"
        );
      });
    }

    return { isAgent, hasVision };
  } catch {
    return defaults;
  }
}
