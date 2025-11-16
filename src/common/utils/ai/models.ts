/**
 * Model configuration and constants
 */

import { DEFAULT_MODEL } from "@/common/constants/knownModels";

export const defaultModel = DEFAULT_MODEL;

/**
 * Extract the model name from a model string (e.g., "anthropic:claude-sonnet-4-5" -> "claude-sonnet-4-5")
 * @param modelString - Full model string in format "provider:model-name"
 * @returns The model name part (after the colon), or the full string if no colon is found
 */
export function getModelName(modelString: string): string {
  const colonIndex = modelString.indexOf(":");
  if (colonIndex === -1) {
    return modelString;
  }
  return modelString.substring(colonIndex + 1);
}

/**
 * Check if a model supports the 1M context window.
 * The 1M context window is only available for Claude Sonnet 4 and Sonnet 4.5.
 * @param modelString - Full model string in format "provider:model-name"
 * @returns True if the model supports 1M context window
 */
export function supports1MContext(modelString: string): boolean {
  const [provider, modelName] = modelString.split(":");
  if (provider !== "anthropic") {
    return false;
  }
  // Check for Sonnet 4 and Sonnet 4.5 models
  return (
    modelName?.includes("claude-sonnet-4") && !modelName.includes("claude-sonnet-3") // Exclude Sonnet 3.x models
  );
}
