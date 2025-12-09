/**
 * Formatting utilities for model display names
 */

/**
 * Format a model name for display with proper capitalization and spacing.
 *
 * Examples:
 * - "claude-sonnet-4-5" -> "Sonnet 4.5"
 * - "claude-opus-4-1" -> "Opus 4.1"
 * - "gpt-5-pro" -> "GPT-5 Pro"
 * - "gpt-4o" -> "GPT-4o"
 * - "gemini-2-0-flash-exp" -> "Gemini 2.0 Flash Exp"
 * - "global.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "Sonnet 4.5"
 *
 * @param modelName - The technical model name (without provider prefix)
 * @returns Formatted display name
 */
export function formatModelDisplayName(modelName: string): string {
  // Bedrock models have format: [region.]vendor.model-name-date-version:0
  // e.g., "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
  //       "us.anthropic.claude-opus-4-20250514-v1:0"
  //       "anthropic.claude-3-5-sonnet-20240620-v1:0"
  const bedrockParsed = parseBedrockModelName(modelName);
  if (bedrockParsed) {
    modelName = bedrockParsed;
  }

  const lower = modelName.toLowerCase();

  // Claude models - extract the model tier and version
  if (lower.startsWith("claude-")) {
    const parts = lower.replace("claude-", "").split("-");

    // Known tiers for Claude models
    const tiers = ["sonnet", "opus", "haiku"];

    // Format: claude-{tier}-{major}-{minor} (newer naming)
    // e.g., "claude-sonnet-4-5" -> "Sonnet 4.5"
    if (parts.length >= 3 && tiers.includes(parts[0])) {
      const tier = capitalize(parts[0]); // sonnet, opus, haiku
      const version = formatVersion(parts.slice(1)); // 4-5 -> 4.5
      return `${tier} ${version}`;
    }

    // Format: claude-{major}-{minor}-{tier} (older naming like claude-3-5-sonnet)
    // e.g., "claude-3-5-sonnet" -> "Sonnet 3.5"
    if (parts.length >= 3) {
      const tierIdx = parts.findIndex((p) => tiers.includes(p));
      if (tierIdx > 0) {
        const tier = capitalize(parts[tierIdx]);
        const version = formatVersion(parts.slice(0, tierIdx));
        return `${tier} ${version}`;
      }
    }

    // Format: claude-{tier}-{major}
    // e.g., "claude-sonnet-4" -> "Sonnet 4"
    if (parts.length === 2 && tiers.includes(parts[0])) {
      const tier = capitalize(parts[0]);
      return `${tier} ${parts[1]}`;
    }
  }

  // GPT models
  if (lower.startsWith("gpt-")) {
    // "gpt-5-pro" -> "GPT-5 Pro"
    // "gpt-4o" -> "GPT-4o"
    // "gpt-4o-mini" -> "GPT-4o Mini"
    const parts = lower.split("-");

    if (parts.length >= 2) {
      // Keep "gpt" and first part together (gpt-5, gpt-4o)
      const base = `GPT-${parts[1]}`;

      // Capitalize remaining parts
      const rest = parts.slice(2).map(capitalize).join(" ");

      return rest ? `${base} ${rest}` : base;
    }
  }

  // Gemini models
  if (lower.startsWith("gemini-")) {
    // "gemini-2-0-flash-exp" -> "Gemini 2.0 Flash Exp"
    const parts = lower.replace("gemini-", "").split("-");

    // Try to detect version pattern (numbers at start)
    const versionParts: string[] = [];
    const nameParts: string[] = [];

    for (const part of parts) {
      if (versionParts.length < 2 && /^\d+$/.test(part)) {
        versionParts.push(part);
      } else {
        nameParts.push(capitalize(part));
      }
    }

    const version = versionParts.length > 0 ? versionParts.join(".") : "";
    const name = nameParts.join(" ");

    if (version && name) {
      return `Gemini ${version} ${name}`;
    } else if (version) {
      return `Gemini ${version}`;
    } else if (name) {
      return `Gemini ${name}`;
    }
  }

  // Ollama models - handle format like "llama3.2:7b" or "codellama:13b"
  // Split by colon to handle quantization/size suffix
  const [baseName, size] = modelName.split(":");
  if (size) {
    // "llama3.2:7b" -> "Llama 3.2 (7B)"
    // "codellama:13b" -> "Codellama (13B)"
    const formatted = baseName
      .split(/(\d+\.?\d*)/)
      .map((part, idx) => {
        if (idx === 0) return capitalize(part);
        if (/^\d+\.?\d*$/.test(part)) return ` ${part}`;
        return part;
      })
      .join("");
    return `${formatted.trim()} (${size.toUpperCase()})`;
  }

  // Fallback: capitalize first letter of each dash-separated part
  return modelName.split("-").map(capitalize).join(" ");
}

/**
 * Capitalize the first letter of a string
 */
function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format version numbers: ["4", "5"] -> "4.5"
 */
function formatVersion(parts: string[]): string {
  return parts.join(".");
}

/**
 * Parse Bedrock model ID to extract the core model name.
 *
 * Bedrock format: [region.]vendor.model-name-date-version:0
 * Examples:
 * - "global.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "claude-sonnet-4-5"
 * - "us.anthropic.claude-opus-4-20250514-v1:0" -> "claude-opus-4"
 * - "anthropic.claude-3-5-sonnet-20240620-v1:0" -> "claude-3-5-sonnet"
 * - "amazon.titan-text-premier-v1:0" -> "titan-text-premier"
 *
 * @returns The extracted model name, or null if not a Bedrock format
 */
function parseBedrockModelName(modelId: string): string | null {
  // Must contain a dot to be Bedrock format
  if (!modelId.includes(".")) {
    return null;
  }

  // Split by dot to get parts
  const dotParts = modelId.split(".");

  // Need at least vendor.modelName (2 parts)
  if (dotParts.length < 2) {
    return null;
  }

  // Check if this looks like a Bedrock model (known vendors or region prefixes)
  const knownVendors = ["anthropic", "amazon", "meta", "cohere", "mistral", "ai21"];
  const knownRegionPrefixes = ["global", "us", "eu", "ap", "sa"];

  const firstPart = dotParts[0].toLowerCase();
  const secondPart = dotParts.length > 1 ? dotParts[1].toLowerCase() : "";

  // Format is either: vendor.model or region.vendor.model
  const isVendor = knownVendors.includes(firstPart);
  const isRegionPrefix = knownRegionPrefixes.some(
    (prefix) => firstPart === prefix || firstPart.startsWith(`${prefix}-`)
  );
  const secondPartIsVendor = knownVendors.includes(secondPart);

  if (!isVendor && !(isRegionPrefix && secondPartIsVendor)) {
    return null;
  }

  // Last part is the model name with possible date/version suffix
  const rawModelName = dotParts[dotParts.length - 1];

  // Remove version suffix like ":0"
  const withoutVersion = rawModelName.split(":")[0];

  // Remove date and version suffix: -YYYYMMDD-vN or just -vN
  // Pattern: model-name[-major[-minor]]-YYYYMMDD-vN
  const dateVersionPattern = /-\d{8}-v\d+$/;
  const versionOnlyPattern = /-v\d+$/;
  const cleanedName = withoutVersion
    .replace(dateVersionPattern, "")
    .replace(versionOnlyPattern, "");

  return cleanedName;
}
