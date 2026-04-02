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

export function normalizeCopilotModelId(id: string): string {
  const unprefixedId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;

  if (!unprefixedId.startsWith("claude-")) {
    return unprefixedId;
  }

  return unprefixedId.replace(/(\d+)\.(\d+)/g, "$1-$2");
}

export function isCopilotModelAccessible(modelId: string, availableModels: string[]): boolean {
  if (availableModels.length === 0) {
    return true;
  }

  const normalizedModelId = normalizeCopilotModelId(modelId);
  return availableModels.some(
    (availableModel) => normalizeCopilotModelId(availableModel) === normalizedModelId
  );
}
