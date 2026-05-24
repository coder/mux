import React from "react";
import { FileIcon } from "@/browser/components/FileIcon/FileIcon";
import { ToolContainer, ToolHeader, ExpandIcon, ToolIcon } from "./Shared/ToolPrimitives";
import type { ToolCoalesceKind } from "@/browser/utils/messages/toolCoalescing";

/**
 * Summary row that takes the place of the head call in a coalesced tool group.
 *
 * Sizing intentionally mirrors a collapsed single-file tool call (same
 * ToolContainer padding, same row height). That keeps the 1 -> N transition
 * flicker-free: when a second file_read lands mid-stream the head row stays
 * pinned in place and only its content changes from "Read /a.ts" to
 * "Read files /a.ts, /b.ts".
 *
 * The component is purely presentational. Expansion state lives on the
 * transcript so the same Set can drive both the head row and the visibility
 * of follow-up member rows.
 */

interface CoalesceKindCopy {
  /** Past-tense verb used in the summary. */
  verb: string;
  /**
   * Tool name routed through {@link ToolIcon}. We deliberately pick a
   * representative variant (e.g. `file_edit_replace_string` for edits) so the
   * icon registry already has a mapping.
   */
  iconToolName: string;
}

const KIND_COPY: Record<ToolCoalesceKind, CoalesceKindCopy> = {
  file_read: { verb: "Read", iconToolName: "file_read" },
  // `file_edit_*` all map to the same Pencil icon via the registry; the
  // specific variant here is just a stable key for ToolIcon's lookup.
  file_edit: { verb: "Wrote", iconToolName: "file_edit_replace_string" },
};

interface CoalescedToolCallProps {
  /** Which tool kind the group represents. */
  kind: ToolCoalesceKind;
  /**
   * File paths involved in the group, in chronological order. Duplicates are
   * left in place — repeated edits to the same file are a meaningful signal
   * that the user can see by expanding.
   */
  filePaths: string[];
  /** Whether the group is currently expanded. */
  expanded: boolean;
  /** Toggle the group's expansion state. */
  onToggle: () => void;
}

export const CoalescedToolCall: React.FC<CoalescedToolCallProps> = ({
  kind,
  filePaths,
  expanded,
  onToggle,
}) => {
  const { verb, iconToolName } = KIND_COPY[kind];
  // Display dedupe: the same file is often read/edited several times in a
  // burst (e.g. multi-hunk edits to one file). Showing "a.ts, a.ts, b.ts"
  // adds noise without information. Preserve chronological order by keeping
  // the first occurrence of each path.
  const uniquePaths = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const path of filePaths) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [filePaths]);

  // The summary is only rendered for groups of >= 2, but guard against zero
  // for type safety and to keep the copy sensible.
  const fileCount = uniquePaths.length;
  const noun = fileCount === 1 ? "file" : "files";
  // Use the first path to drive the small file-type icon — gives the row a
  // visual anchor that matches the single-call layout.
  const leadingPath = uniquePaths[0] ?? "";
  const joinedPaths = uniquePaths.join(", ");

  return (
    <ToolContainer expanded={false} className="@container">
      <ToolHeader onClick={onToggle} aria-expanded={expanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName={iconToolName} />
        <div className="text-text flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0">
            {verb} {noun}
          </span>
          {leadingPath && (
            <FileIcon filePath={leadingPath} className="shrink-0 text-[15px] leading-none" />
          )}
          <span className="font-monospace min-w-0 truncate" title={joinedPaths}>
            {joinedPaths}
          </span>
        </div>
        <span className="text-secondary ml-2 shrink-0 text-[10px] whitespace-nowrap">
          {fileCount}
        </span>
      </ToolHeader>
    </ToolContainer>
  );
};
