import type { SubagentGitPatchArtifact } from "@/common/utils/tools/toolDefinitions";

export function formatGitPatchArtifactSummary(
  gitPatchArtifact: SubagentGitPatchArtifact | undefined
): string | null {
  if (!gitPatchArtifact) return null;

  const readySummary =
    gitPatchArtifact.readyProjectCount > 0
      ? `${gitPatchArtifact.readyProjectCount} ready`
      : undefined;
  const skippedSummary =
    gitPatchArtifact.skippedProjectCount > 0
      ? `${gitPatchArtifact.skippedProjectCount} skipped`
      : undefined;
  const failedSummary =
    gitPatchArtifact.failedProjectCount > 0
      ? `${gitPatchArtifact.failedProjectCount} failed`
      : undefined;
  const projectSummary = [readySummary, skippedSummary, failedSummary]
    .filter((summary): summary is string => typeof summary === "string")
    .join(", ");
  const commitLabel = gitPatchArtifact.totalCommitCount === 1 ? "commit" : "commits";

  switch (gitPatchArtifact.status) {
    case "pending":
      return projectSummary.length > 0 ? `Patch: pending (${projectSummary})` : "Patch: pending";
    case "skipped":
      return projectSummary.length > 0
        ? `Patch: skipped (${projectSummary})`
        : "Patch: skipped (no commits)";
    case "ready":
      return projectSummary.length > 0
        ? `Patch: ready (${projectSummary}; ${gitPatchArtifact.totalCommitCount} ${commitLabel})`
        : `Patch: ready (${gitPatchArtifact.totalCommitCount} ${commitLabel})`;
    case "failed": {
      const failedProject = gitPatchArtifact.projectArtifacts.find(
        (projectArtifact) => projectArtifact.status === "failed"
      );
      const error = failedProject?.error?.trim();
      const shortError =
        error && error.length > 80 ? `${error.slice(0, 77)}…` : (error ?? undefined);
      if (projectSummary.length > 0) {
        return shortError
          ? `Patch: failed (${projectSummary}; ${shortError})`
          : `Patch: failed (${projectSummary})`;
      }
      return shortError ? `Patch: failed (${shortError})` : "Patch: failed";
    }
    default:
      return `Patch: ${String(gitPatchArtifact.status)}`;
  }
}
