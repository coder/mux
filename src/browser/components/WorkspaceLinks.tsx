/**
 * Component to display the PR badge in the workspace header.
 * PR is detected from the workspace's current branch via `gh pr view`.
 */

import { useWorkspacePR } from "@/browser/stores/PRStatusStore";
import { PRLinkBadge } from "./PRLinkBadge";

interface WorkspaceLinksProps {
  workspaceId: string;
}

export function WorkspaceLinks({ workspaceId }: WorkspaceLinksProps) {
  const workspacePR = useWorkspacePR(workspaceId);

  if (!workspacePR) {
    return null;
  }

  return <PRLinkBadge prLink={workspacePR} />;
}
