import React from "react";
import { FileText } from "lucide-react";
import type {
  InlineSkillSnapshotMap,
  ReviewNoteDataForDisplay,
  WorkflowDefinitionPreviewForDisplay,
} from "@/common/types/message";
import type { FilePart } from "@/common/orpc/schemas";
import { ReviewBlockFromData } from "../Shared/ReviewBlock";
import {
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from "@/browser/components/HoverCard/HoverCard";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { HoverClickPopover } from "@/browser/components/HoverClickPopover/HoverClickPopover";
import { AgentSkillBadge } from "./AgentSkillBadge";
import { buildAgentSkillSnapshotMarkdown } from "./agentSkillSnapshotMarkdown";

export function WorkflowDefinitionPreviewCard(props: {
  preview: WorkflowDefinitionPreviewForDisplay;
}) {
  const descriptor = props.preview.descriptor;
  const source = props.preview.source?.trimEnd();

  return (
    <div data-component="WorkflowDefinitionPreviewCard" className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground font-mono text-[13px] font-semibold">
          {descriptor.name}
        </span>
        <span className="border-border-light text-plan-mode shrink-0 rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
          {descriptor.scope} workflow
        </span>
        {!descriptor.executable && (
          <span className="border-warning/30 text-warning shrink-0 rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
            blocked
          </span>
        )}
      </div>
      <div className="text-muted text-[12px] leading-relaxed">{descriptor.description}</div>
      {descriptor.sourcePath && (
        <div className="text-muted truncate font-mono text-[10px]">{descriptor.sourcePath}</div>
      )}
      {descriptor.blockedReason && (
        <div className="text-warning text-[11px]">{descriptor.blockedReason}</div>
      )}
      {source && (
        <pre
          aria-label={`Source for workflow ${descriptor.name}`}
          className="border-border bg-code-bg focus-visible:ring-accent max-h-[260px] overflow-auto rounded border p-2 text-[11px] leading-relaxed focus-visible:ring-1 focus-visible:outline-none"
          role="region"
          tabIndex={0}
        >
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}

interface UserMessageContentProps {
  content: string;
  commandPrefix?: string;
  /**
   * Optional agent-skill snapshot content for /{skillName} invocations.
   * When present, the command prefix badge shows a hover preview.
   */
  agentSkillSnapshot?: { frontmatterYaml?: string; body?: string };
  workflowDefinitionPreview?: WorkflowDefinitionPreviewForDisplay;
  inlineSkillSnapshots?: InlineSkillSnapshotMap;
  reviews?: ReviewNoteDataForDisplay[];
  fileParts?: FilePart[];
  /** Controls styling: "sent" for full styling, "queued" for muted preview */
  variant: "sent" | "queued";
}

const markdownStyles: Record<UserMessageContentProps["variant"], React.CSSProperties> = {
  sent: {
    color: "var(--color-user-text)",
    overflowWrap: "break-word",
    wordBreak: "break-word",
  },
  queued: {
    color: "var(--color-subtle)",
    fontFamily: "var(--font-monospace)",
    fontSize: "12px",
    lineHeight: "16px",
    overflowWrap: "break-word",
    wordBreak: "break-word",
    opacity: 0.9,
  },
};

const imageContainerStyles = {
  sent: "mt-3 flex flex-wrap gap-3",
  queued: "mt-2 flex flex-wrap gap-2",
} as const;

const markdownClassName = "user-message-markdown";

function dataUrlToBlob(dataUrl: string): Blob | null {
  if (!dataUrl.startsWith("data:")) return null;

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;

  const mimeType = header.split(";")[0] ?? "application/octet-stream";

  try {
    const base64 = dataUrl.slice(commaIndex + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

const fileAttachmentStyles = {
  sent: "flex max-w-80 items-center gap-2 rounded-xl border border-[var(--color-attachment-border)] px-3 py-2 text-sm text-[var(--color-subtle)]",
  queued:
    "border-border-light flex max-w-80 items-center gap-2 rounded border px-2 py-1 text-xs text-[var(--color-subtle)]",
} as const;
const imageStyles = {
  sent: "max-h-[300px] max-w-72 rounded-xl border border-[var(--color-attachment-border)] object-cover",
  queued: "border-border-light max-h-[300px] max-w-80 rounded border",
} as const;

/**
 * Shared content renderer for user messages (sent and queued).
 * Handles reviews, text content, and attachments.
 */
export const UserMessageContent: React.FC<UserMessageContentProps> = (props) => {
  const reviews = props.reviews ?? [];
  const fileParts = props.fileParts ?? [];

  const hasReviews = reviews.length > 0;

  // Strip review tags from text when displaying alongside review blocks
  const textContent = hasReviews
    ? props.content.replace(/<review>[\s\S]*?<\/review>\s*/g, "").trim()
    : props.content;

  // Check if content starts with the command prefix
  const shouldHighlightPrefix =
    props.commandPrefix && textContent.startsWith(props.commandPrefix)
      ? props.commandPrefix
      : undefined;

  // Content after the prefix (if highlighting)
  const remainingContent = shouldHighlightPrefix
    ? textContent.slice(shouldHighlightPrefix.length)
    : textContent;

  // Render text content with optional command prefix badge
  const renderTextContent = () => {
    if (!remainingContent && !shouldHighlightPrefix) return null;

    // No prefix highlighting - render markdown directly without wrapper
    if (!shouldHighlightPrefix) {
      return (
        <MarkdownRenderer
          content={textContent}
          className={markdownClassName}
          style={markdownStyles[props.variant]}
          inlineSkillSnapshots={props.inlineSkillSnapshots}
          preserveLineBreaks
        />
      );
    }

    // Check what whitespace follows the prefix to preserve visual layout
    const charAfterPrefix = textContent.charAt(shouldHighlightPrefix.length);
    const hasSpaceAfterPrefix = charAfterPrefix === " ";
    const hasNewlineAfterPrefix = charAfterPrefix === "\n";

    const snapshotMarkdown = buildAgentSkillSnapshotMarkdown(props.agentSkillSnapshot);
    const workflowDefinitionPreview = props.workflowDefinitionPreview;

    const badge = snapshotMarkdown ? (
      <HoverCard openDelay={150}>
        <HoverCardTrigger asChild>
          <AgentSkillBadge
            as="button"
            aria-label={`Show skill preview for ${shouldHighlightPrefix}`}
            className="cursor-help"
          >
            {shouldHighlightPrefix}
          </AgentSkillBadge>
        </HoverCardTrigger>
        {/* Keep skill preview above chat chrome and fully opaque while hovering. */}
        <HoverCardPortal>
          <HoverCardContent
            align="start"
            side="top"
            className="border-border-medium bg-modal-bg z-[1600] max-h-[360px] w-[520px] max-w-[80vw] overflow-auto border-2 p-3"
          >
            <MarkdownRenderer content={snapshotMarkdown} preserveLineBreaks />
          </HoverCardContent>
        </HoverCardPortal>
      </HoverCard>
    ) : workflowDefinitionPreview ? (
      <HoverClickPopover
        align="start"
        content={<WorkflowDefinitionPreviewCard preview={workflowDefinitionPreview} />}
        contentClassName="border-border-medium bg-modal-bg z-[1600] max-h-[360px] w-[560px] max-w-[80vw] overflow-auto border-2 p-3"
        interactiveContent
        side="top"
      >
        {/* Workflow previews use the run record snapshot so old invocations show what actually ran. */}
        <AgentSkillBadge
          as="button"
          aria-label={`Show workflow definition preview for ${workflowDefinitionPreview.descriptor.name}`}
          className="cursor-help"
        >
          {shouldHighlightPrefix}
        </AgentSkillBadge>
      </HoverClickPopover>
    ) : (
      <AgentSkillBadge>{shouldHighlightPrefix}</AgentSkillBadge>
    );

    // Newline after prefix: block layout (badge on own line)
    // Space after prefix: inline layout (badge + content on same line)
    return (
      <div className={hasNewlineAfterPrefix ? "" : "flex flex-wrap items-baseline"}>
        {badge}
        {hasSpaceAfterPrefix && <span>&nbsp;</span>}
        {remainingContent.trim() && (
          <MarkdownRenderer
            content={remainingContent.trim()}
            className={markdownClassName}
            style={markdownStyles[props.variant]}
            inlineSkillSnapshots={props.inlineSkillSnapshots}
            preserveLineBreaks
          />
        )}
      </div>
    );
  };

  return (
    <>
      {hasReviews ? (
        <div className="space-y-2">
          {reviews.map((review, idx) => (
            <ReviewBlockFromData key={idx} data={review} />
          ))}
          {renderTextContent()}
        </div>
      ) : (
        renderTextContent()
      )}
      {fileParts.length > 0 && (
        <div className={imageContainerStyles[props.variant]}>
          {fileParts.map((part, idx) => {
            const baseMediaType = getBaseMediaType(part.mediaType);
            if (baseMediaType.startsWith("image/")) {
              return (
                <img
                  key={idx}
                  src={part.url}
                  alt={`Attachment ${idx + 1}`}
                  className={imageStyles[props.variant]}
                />
              );
            }

            const label =
              part.filename ??
              (baseMediaType === "application/pdf"
                ? "PDF attachment"
                : `Attachment (${baseMediaType})`);

            return (
              <a
                key={idx}
                href={part.url}
                target="_blank"
                rel="noreferrer"
                className={fileAttachmentStyles[props.variant]}
                onClick={(event) => {
                  const blob = dataUrlToBlob(part.url);
                  if (!blob) {
                    return;
                  }

                  event.preventDefault();

                  const blobUrl = URL.createObjectURL(blob);

                  if (isDesktopMode()) {
                    // In desktop mode, new windows are routed via shell.openExternal.
                    // blob: URLs are tied to this renderer and won't resolve externally,
                    // so download the file in-app instead.
                    const link = document.createElement("a");
                    link.href = blobUrl;
                    link.download =
                      part.filename ??
                      (baseMediaType === "application/pdf" ? "attachment.pdf" : "attachment");
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                    return;
                  }

                  window.open(blobUrl, "_blank", "noopener,noreferrer");

                  // Keep the blob URL alive long enough for the new tab to load.
                  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
                }}
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">{label}</span>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
};
