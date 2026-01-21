import React from "react";
import { FileIcon } from "@/browser/components/FileIcon";
import { parsePatch } from "diff";
import type {
  FileEditInsertToolArgs,
  FileEditInsertToolResult,
  FileEditReplaceStringToolArgs,
  FileEditReplaceStringToolResult,
  FileEditReplaceLinesToolArgs,
  FileEditReplaceLinesToolResult,
} from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  LoadingDots,
  ToolIcon,
  ErrorBox,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { DiffContainer, DiffRenderer, SelectableDiffRenderer } from "../shared/DiffRenderer";
import { KebabMenu, type KebabMenuItem } from "../KebabMenu";
import type { ReviewNoteData } from "@/common/types/review";

type FileEditOperationArgs =
  | FileEditReplaceStringToolArgs
  | FileEditReplaceLinesToolArgs
  | FileEditInsertToolArgs;

type FileEditToolResult =
  | FileEditReplaceStringToolResult
  | FileEditReplaceLinesToolResult
  | FileEditInsertToolResult;

interface FileEditToolCallProps {
  toolName: "file_edit_replace_string" | "file_edit_replace_lines" | "file_edit_insert";
  args: FileEditOperationArgs;
  result?: FileEditToolResult;
  status?: ToolStatus;
  onReviewNote?: (data: ReviewNoteData) => void;
}

function renderDiff(
  diff: string,
  filePath?: string,
  onReviewNote?: (data: ReviewNoteData) => void
): React.ReactNode {
  try {
    const patches = parsePatch(diff);
    if (patches.length === 0) {
      return <div style={{ padding: "8px", color: "var(--color-muted)" }}>No changes</div>;
    }

    // Render each hunk using SelectableDiffRenderer if we have a callback, otherwise DiffRenderer
    return patches.map((patch, patchIdx) => (
      <React.Fragment key={patchIdx}>
        {patch.hunks.map((hunk, hunkIdx) => (
          <React.Fragment key={hunkIdx}>
            {onReviewNote && filePath ? (
              <SelectableDiffRenderer
                content={hunk.lines.join("\n")}
                showLineNumbers={true}
                oldStart={hunk.oldStart}
                newStart={hunk.newStart}
                filePath={filePath}
                fontSize="11px"
                onReviewNote={onReviewNote}
              />
            ) : (
              <DiffRenderer
                content={hunk.lines.join("\n")}
                showLineNumbers={true}
                oldStart={hunk.oldStart}
                newStart={hunk.newStart}
                filePath={filePath}
                fontSize="11px"
              />
            )}
          </React.Fragment>
        ))}
      </React.Fragment>
    ));
  } catch (error) {
    return <ErrorBox>Failed to parse diff: {String(error)}</ErrorBox>;
  }
}

export const FileEditToolCall: React.FC<FileEditToolCallProps> = ({
  toolName,
  args,
  result,
  status = "pending",
  onReviewNote,
}) => {
  // Collapse failed edits by default since they're common and expected
  const isFailed = result && !result.success;
  const initialExpanded = !isFailed;

  const { expanded, toggleExpanded } = useToolExpansion(initialExpanded);
  const [showRaw, setShowRaw] = React.useState(false);

  const filePath = "file_path" in args ? args.file_path : undefined;

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard();

  // Build kebab menu items for successful edits with diffs
  const kebabMenuItems: KebabMenuItem[] =
    result && result.success && result.diff
      ? [
          {
            label: copied ? "Copied" : "Copy Patch",
            onClick: () => void copyToClipboard(result.diff),
          },
          {
            label: showRaw ? "Show Parsed" : "Show Patch",
            onClick: () => setShowRaw(!showRaw),
            active: showRaw,
          },
        ]
      : [];

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader className="hover:text-secondary cursor-default">
        <div
          onClick={toggleExpanded}
          className="hover:text-text flex flex-1 cursor-pointer items-center gap-2"
        >
          <ExpandIcon expanded={expanded}>▶</ExpandIcon>
          <ToolIcon toolName={toolName} />
          <div className="text-text flex max-w-96 min-w-0 items-center gap-1.5">
            <FileIcon filePath={filePath} className="text-[15px] leading-none" />
            <span className="font-monospace truncate">{filePath}</span>
          </div>
        </div>
        {!(result && result.success && result.diff) && (
          <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
        )}
        {kebabMenuItems.length > 0 && (
          <div className="mr-2">
            <KebabMenu items={kebabMenuItems} />
          </div>
        )}
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {result && (
            <>
              {result.success === false && result.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{result.error}</ErrorBox>
                </DetailSection>
              )}

              {result.success &&
                result.diff &&
                (showRaw ? (
                  <DiffContainer>
                    <pre className="font-monospace m-0 text-[11px] leading-[1.4] break-words whitespace-pre-wrap">
                      {result.diff}
                    </pre>
                  </DiffContainer>
                ) : (
                  renderDiff(result.diff, filePath, onReviewNote)
                ))}
            </>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <div className="text-secondary text-[11px]">
                Waiting for result
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
