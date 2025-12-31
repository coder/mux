import type { ExistingBranchSelection } from "@/common/types/branchSelection";

export interface RemoteBranchGroupLike {
  remote: string;
  branches: string[];
}

/**
 * Infer whether the current input value exactly matches an existing branch.
 *
 * This is used to keep workspace creation semantics correct:
 * - If the name matches an existing local branch, treat it as existing.
 * - If the name matches an existing remote-only branch, treat it as existing and prefer `origin`
 *   when the same branch name exists on multiple remotes.
 */
export function inferExactExistingBranchSelection(params: {
  value: string;
  localBranches: string[];
  remoteGroups: RemoteBranchGroupLike[];
}): ExistingBranchSelection | null {
  if (params.value.length === 0) return null;

  const searchLower = params.value.toLowerCase();

  const exactLocalMatch = params.localBranches.find((b) => b.toLowerCase() === searchLower);
  if (exactLocalMatch) {
    return { kind: "local", branch: exactLocalMatch };
  }

  const remoteMatches: Array<{ remote: string; branch: string }> = [];
  for (const group of params.remoteGroups) {
    const branch = group.branches.find((b) => b.toLowerCase() === searchLower);
    if (branch) {
      remoteMatches.push({ remote: group.remote, branch });
    }
  }

  if (remoteMatches.length === 0) return null;

  const chosen =
    remoteMatches.length === 1
      ? remoteMatches[0]
      : (remoteMatches.find((m) => m.remote === "origin") ?? remoteMatches[0]);

  return { kind: "remote", remote: chosen.remote, branch: chosen.branch };
}
