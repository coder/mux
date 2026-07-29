/** The PR is detected from the workspace's current branch via `gh pr view`. */

import { useWorkspacePR } from "@/browser/stores/PRStatusStore";
import { PRLinkBadge } from "../PRLinkBadge/PRLinkBadge";

interface WorkspaceLinksProps {
  workspaceId: string;
  /** Applied to the badge itself so callers can hide it without leaving an empty flex item. */
  className?: string;
}

export function WorkspaceLinks({ workspaceId, className }: WorkspaceLinksProps) {
  const workspacePR = useWorkspacePR(workspaceId);

  if (!workspacePR) {
    return null;
  }

  return <PRLinkBadge prLink={workspacePR} className={className} />;
}
