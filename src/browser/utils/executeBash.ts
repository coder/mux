/**
 * Repo-context scripts must opt into repo-root execution so multi-project workspaces can keep
 * default script mode on the shared container root without regressing git/file viewers.
 */
export function repoRootBashOptions(timeout_secs?: number): {
  timeout_secs?: number;
  cwdMode: "repo-root";
} {
  return timeout_secs == null ? { cwdMode: "repo-root" } : { timeout_secs, cwdMode: "repo-root" };
}
