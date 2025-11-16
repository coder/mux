/**
 * Standard environment variables for non-interactive command execution.
 * These prevent tools from blocking on editor/credential prompts.
 */
export const NON_INTERACTIVE_ENV_VARS = {
  // Prevent interactive editors from blocking execution
  // Critical for git operations like rebase/commit that try to open editors
  GIT_EDITOR: "true", // Git-specific editor (highest priority)
  GIT_SEQUENCE_EDITOR: "true", // For interactive rebase sequences
  EDITOR: "true", // General fallback for non-git commands
  VISUAL: "true", // Another common editor environment variable
  // Prevent git from prompting for credentials
  GIT_TERMINAL_PROMPT: "0", // Disables git credential prompts
} as const;
