import { shellQuote } from "@/common/utils/shell";

export function buildCheckoutScript(checkoutTarget: string): string {
  // SECURITY: branch names are attacker-controlled repository metadata;
  // quote them before interpolating into a shell command.
  // Add `--` after the branch ref to disambiguate against local paths with the same name.
  return `git checkout ${shellQuote(checkoutTarget)} -- 2>&1`;
}

export function buildRemoteBranchListScript(remote: string, maxRemoteBranches: number): string {
  const remotePattern = `${remote}/*`;
  // SECURITY: remote names come from repository metadata (untrusted input),
  // so shell-quote before interpolation to prevent command injection.
  // Keep pattern after `--` so Git always parses it as a ref glob, not an option.
  return `git branch -r --list --sort=-committerdate --format='%(refname:short)' -- ${shellQuote(remotePattern)} 2>/dev/null | head -${maxRemoteBranches + 1}`;
}
