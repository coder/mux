/**
 * Component to display detected links in the workspace header.
 * Shows:
 * - PR badge: from branch-based detection (via `gh pr view`)
 * - Links dropdown: from chat-extracted links
 */

import { useWorkspaceLinks } from "@/browser/stores/WorkspaceStore";
import { useWorkspacePR } from "@/browser/stores/PRStatusStore";
import type { GenericLink } from "@/common/types/links";
import { PRLinkBadge } from "./PRLinkBadge";
import { LinksDropdown } from "./LinksDropdown";

interface WorkspaceLinksProps {
  workspaceId: string;
}

export function WorkspaceLinks({ workspaceId }: WorkspaceLinksProps) {
  // Get links extracted from chat (for dropdown)
  const { detectedLinks } = useWorkspaceLinks(workspaceId);

  // Get PR for this workspace's branch (not from chat)
  const workspacePR = useWorkspacePR(workspaceId);

  // Filter out generic links (non-PR) for dropdown
  const genericLinks = detectedLinks.filter((link): link is GenericLink => link.type === "generic");

  // Don't render anything if no PR and no links
  if (!workspacePR && genericLinks.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1">
      {/* Show the workspace's PR badge (from branch detection) */}
      {workspacePR && <PRLinkBadge prLink={workspacePR} />}

      {/* Generic links dropdown (from chat) */}
      {genericLinks.length > 0 && <LinksDropdown links={genericLinks} />}
    </div>
  );
}
