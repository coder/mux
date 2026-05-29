export const CONTEXT_RESET_SUCCESS_MESSAGE = "Context reset; history preserved";
export const CONTEXT_RESET_NOOP_MESSAGE = "No context to reset";

export function getContextResetSuccessMessage(result: "reset" | "noop"): string {
  return result === "noop" ? CONTEXT_RESET_NOOP_MESSAGE : CONTEXT_RESET_SUCCESS_MESSAGE;
}
