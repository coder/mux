export type CopilotApiMode = "responses" | "chatCompletions";

// Keep this in sync with the Copilot model filtering used after OAuth login.
export const COPILOT_MODEL_PREFIXES = ["gpt-5", "claude-", "gemini-3", "grok-code"] as const;

export function isCopilotRoutableModel(modelId: string): boolean {
  return !modelId.includes("-codex");
}

export function selectCopilotApiMode(_modelId: string): CopilotApiMode {
  // GitHub Copilot Responses output is currently incompatible with the AI SDK parser,
  // so every Copilot model stays on chat completions until that upstream path is reliable.
  return "chatCompletions";
}

export function isCopilotModelAccessible(modelId: string, availableModels: string[]): boolean {
  if (availableModels.length === 0) {
    return true;
  }

  return availableModels.includes(modelId);
}
