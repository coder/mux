export type CopilotApiMode = "responses" | "chatCompletions";

// Keep this in sync with the Copilot model filtering used after OAuth login.
export const COPILOT_MODEL_PREFIXES = ["gpt-5", "claude-", "gemini-3", "grok-code"] as const;

export function isCopilotRoutableModel(_modelId: string): boolean {
  return true;
}

export function selectCopilotApiMode(modelId: string): CopilotApiMode {
  // Copilot Codex-family models are proven to work through the custom Responses path.
  // Keep the broader Copilot catalog on chat completions until the upstream parser is reliable.
  return modelId.includes("-codex") ? "responses" : "chatCompletions";
}

export function normalizeCopilotModelId(id: string): string {
  const unprefixedId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;

  if (!unprefixedId.startsWith("claude-")) {
    return unprefixedId;
  }

  return unprefixedId.replace(/(\d+)\.(\d+)/g, "$1-$2");
}

export function toCopilotModelId(id: string): string {
  const unprefixedId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;

  if (!unprefixedId.startsWith("claude-")) {
    return unprefixedId;
  }

  // Copilot expects Claude major.minor versions in dot form, but date-stamped suffixes must stay dashed.
  const versionMatch = /^(claude-[a-z0-9-]*?)-(\d+)-(\d{1,2})(-\d{8})?$/.exec(unprefixedId);
  if (!versionMatch) {
    return unprefixedId;
  }

  const [, prefix, majorVersion, minorVersion, suffix = ""] = versionMatch;
  return `${prefix}-${majorVersion}.${minorVersion}${suffix}`;
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
