export type CodeExecutionViewMode = "tools" | "result" | "code" | "console";

interface ResolveCodeExecutionViewModeOptions {
  isComplete: boolean;
  hasToolCalls: boolean;
  noToolCallsDefaultView: Extract<CodeExecutionViewMode, "result" | "code">;
}

export function resolveCodeExecutionViewMode(
  mode: CodeExecutionViewMode,
  options: ResolveCodeExecutionViewModeOptions
): CodeExecutionViewMode {
  if (mode === "tools" && options.isComplete && !options.hasToolCalls) {
    return options.noToolCallsDefaultView;
  }

  return mode;
}
