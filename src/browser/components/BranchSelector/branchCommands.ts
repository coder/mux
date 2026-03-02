export interface BranchSelectorGitCommand {
  command: "git";
  args: string[];
}

export function buildCheckoutCommand(checkoutTarget: string): BranchSelectorGitCommand {
  // SECURITY: branch names are attacker-controlled repository metadata.
  // Build argv for backend execution so the branch name remains an opaque argument,
  // not interpolated shell text.
  return {
    command: "git",
    args: ["checkout", checkoutTarget, "--"],
  };
}

export function buildRemoteBranchListCommand(
  remote: string,
  maxRemoteBranches: number
): BranchSelectorGitCommand {
  // SECURITY: remote names are untrusted repository metadata. Keep the remote portion
  // as a single argv element and let Git parse it as a ref namespace.
  return {
    command: "git",
    args: [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      `--count=${maxRemoteBranches + 1}`,
      `refs/remotes/${remote}`,
    ],
  };
}
