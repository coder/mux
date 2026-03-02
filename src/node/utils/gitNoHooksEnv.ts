/**
 * Environment variables that disable git hooks by pointing core.hooksPath
 * to /dev/null. Used for untrusted projects to prevent repo-controlled
 * hooks from executing during git operations.
 */
export const GIT_NO_HOOKS_ENV = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  // Clear the deprecated GIT_CONFIG_PARAMETERS to prevent it from overriding
  // the numbered GIT_CONFIG_* variables above (it takes precedence in git).
  GIT_CONFIG_PARAMETERS: "",
} as const;

/**
 * Build a shell command prefix that disables git hooks for untrusted projects.
 * Returns empty string when trusted, or "GIT_CONFIG_COUNT=1 ... " when untrusted.
 */
export function gitNoHooksPrefix(trusted?: boolean): string {
  if (trusted) return "";
  return (
    Object.entries(GIT_NO_HOOKS_ENV)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") + " "
  );
}
