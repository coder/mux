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
 *
 * @param modelName - The technical model name (without provider prefix)
 * @returns Formatted display name
 */
export function formatModelDisplayName(modelName: string): string {
  const lower = modelName.toLowerCase();

  // Claude models - extract the model tier and version
  if (lower.startsWith("claude-")) {
    const parts = lower.replace("claude-", "").split("-");

    // Format: claude-{tier}-{major}-{minor}
    // e.g., "claude-sonnet-4-5" -> "Sonnet 4.5"
    if (parts.length >= 3) {
      const tier = capitalize(parts[0]); // sonnet, opus, haiku
      const version = formatVersion(parts.slice(1)); // 4-5 -> 4.5
      return `${tier} ${version}`;
    }

    // Format: claude-{tier}-{major}
    // e.g., "claude-sonnet-4" -> "Sonnet 4"
    if (parts.length === 2) {
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
