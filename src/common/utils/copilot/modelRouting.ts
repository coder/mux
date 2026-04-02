export type CopilotApiMode = "responses" | "chatCompletions";

// Keep this in sync with the Copilot model filtering used after OAuth login.
export const COPILOT_MODEL_PREFIXES = ["gpt-5", "claude-", "gemini-3", "grok-code"] as const;

interface CopilotApiModeRule {
  pattern: RegExp;
  mode: CopilotApiMode;
}

// GitHub Copilot only supports the Responses API for Codex-family models.
// Everything else must use chat completions.
const COPILOT_API_MODE_RULES: readonly CopilotApiModeRule[] = [
  { pattern: /-codex/, mode: "responses" },
];

export function selectCopilotApiMode(modelId: string): CopilotApiMode {
  const matchingRule = COPILOT_API_MODE_RULES.find((rule) => rule.pattern.test(modelId));
  return matchingRule?.mode ?? "chatCompletions";
}

export function isCopilotModelAccessible(modelId: string, availableModels: string[]): boolean {
  if (availableModels.length === 0) {
    return true;
  }

  return availableModels.includes(modelId);
}
