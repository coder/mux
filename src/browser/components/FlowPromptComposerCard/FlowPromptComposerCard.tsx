import React from "react";
import { parsePatch } from "diff";
import {
  ChevronDown,
  ChevronRight,
  Clipboard,
  ClipboardCheck,
  FileText,
  Send,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { FlowPromptAutoSendMode } from "@/common/constants/flowPrompting";
import type { FlowPromptState } from "@/common/orpc/types";
import { Button } from "@/browser/components/Button/Button";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { UserMessageContent } from "@/browser/features/Messages/UserMessageContent";
import { DiffRenderer } from "@/browser/features/Shared/DiffRenderer";
import { cn } from "@/common/lib/utils";

type FlowPromptPreviewKind = "diff" | "contents" | "cleared" | "raw";

interface FlowPromptPreviewDisplay {
  kind: FlowPromptPreviewKind;
  content: string;
}

interface FlowPromptComposerCardProps {
  state: FlowPromptState;
  error?: string | null;
  isCollapsed?: boolean;
  isUpdatingAutoSendMode?: boolean;
  isSendingNow?: boolean;
  onOpen: () => void;
  onDisable: () => void;
  onSendNow: () => void;
  onToggleCollapsed: () => void;
  onAutoSendModeChange: (mode: FlowPromptAutoSendMode) => void;
}

export function shouldShowFlowPromptComposerCard(
  state:
    | Pick<FlowPromptState, "exists" | "updatePreviewText" | "hasPendingUpdate">
    | null
    | undefined
): boolean {
  return (
    state != null && (state.exists || state.updatePreviewText != null || state.hasPendingUpdate)
  );
}

function getFlowPromptPreviewDisplay(
  previewText: string | null | undefined
): FlowPromptPreviewDisplay | null {
  if (typeof previewText !== "string" || previewText.trim().length === 0) {
    return null;
  }

  const diffPrefix = "Latest flow prompt changes:\n```diff\n";
  const contentsPrefix = "Current flow prompt contents:\n```md\n";
  const emptyText = "The flow prompt file is now empty.";

  const firstSectionBreak = previewText.indexOf("\n\n");
  const secondSectionBreak =
    firstSectionBreak === -1 ? -1 : previewText.indexOf("\n\n", firstSectionBreak + 2);
  const body =
    secondSectionBreak === -1 ? previewText : previewText.slice(secondSectionBreak + "\n\n".length);

  if (body.startsWith(diffPrefix)) {
    const diffStart = diffPrefix.length;
    const closingFenceIndex = body.lastIndexOf("\n```");
    return {
      kind: "diff",
      content:
        closingFenceIndex >= diffStart
          ? body.slice(diffStart, closingFenceIndex)
          : body.slice(diffStart),
    };
  }

  if (body.startsWith(contentsPrefix)) {
    const contentStart = contentsPrefix.length;
    const closingFenceIndex = body.lastIndexOf("\n```");

    return {
      kind: "contents",
      content:
        closingFenceIndex >= contentStart
          ? body.slice(contentStart, closingFenceIndex)
          : body.slice(contentStart),
    };
  }

  if (body.startsWith(emptyText)) {
    return {
      kind: "cleared",
      content: body.trim(),
    };
  }

  return {
    kind: "raw",
    content: previewText,
  };
}

function getFlowPromptPreviewLabel(params: {
  hasPendingUpdate: boolean;
  kind: FlowPromptPreviewKind;
}): string {
  const prefix = params.hasPendingUpdate ? "Queued" : "Live";
  if (params.kind === "contents") {
    return `${prefix} flow prompt contents`;
  }
  if (params.kind === "cleared") {
    return `${prefix} flow prompt clear`;
  }
  if (params.kind === "raw") {
    return `${prefix} flow prompt update`;
  }
  return `${prefix} flow prompt diff`;
}

function getCollapsedStatusText(params: {
  hasPendingUpdate: boolean;
  hasPreview: boolean;
  autoSendMode: FlowPromptAutoSendMode;
}): string {
  if (params.hasPendingUpdate) {
    return "Queued for end of turn";
  }
  if (params.hasPreview) {
    return params.autoSendMode === "end-of-turn" ? "Ready now · auto-send on" : "Ready to send";
  }
  return params.autoSendMode === "end-of-turn" ? "Watching saves · auto-send on" : "Watching saves";
}

function renderFlowPromptDiffPreview(diff: string, filePath: string): React.ReactNode {
  try {
    const patches = parsePatch(diff);
    if (patches.length === 0) {
      return <UserMessageContent content={`\`\`\`diff\n${diff}\n\`\`\``} variant="queued" />;
    }

    // Reuse the parsed file-edit diff presentation here so Flow Prompting previews read like
    // the rest of Mux's diff UIs instead of a raw fenced patch blob.
    return patches.map((patch, patchIdx) => (
      <React.Fragment key={`${patch.oldFileName ?? filePath}-${patchIdx}`}>
        {patch.hunks.map((hunk, hunkIdx) => (
          <DiffRenderer
            key={`${patchIdx}-${hunk.oldStart}-${hunk.newStart}-${hunkIdx}`}
            content={hunk.lines.join("\n")}
            showLineNumbers={true}
            oldStart={hunk.oldStart}
            newStart={hunk.newStart}
            filePath={filePath}
            fontSize="11px"
          />
        ))}
      </React.Fragment>
    ));
  } catch {
    return <UserMessageContent content={`\`\`\`diff\n${diff}\n\`\`\``} variant="queued" />;
  }
}

export const FlowPromptComposerCard: React.FC<FlowPromptComposerCardProps> = (props) => {
  const preview = getFlowPromptPreviewDisplay(props.state.updatePreviewText);
  const hasPreview = preview != null;
  const { copied, copyToClipboard } = useCopyToClipboard();
  const canCopyPath = props.state.path.trim().length > 0;
  const isAutoSendChanging = props.isUpdatingAutoSendMode === true;
  const isCollapsed = props.isCollapsed === true;
  const isSendingNow = props.isSendingNow === true;
  const statusText =
    !props.state.exists && preview?.kind === "cleared"
      ? props.state.hasPendingUpdate
        ? "Flow prompt file deleted. The clear update is queued for the end of this turn."
        : "Flow prompt file deleted. Send this clear update to remove prior prompt instructions."
      : props.state.hasPendingUpdate
        ? "Latest save is queued for the end of this turn."
        : hasPreview
          ? props.state.autoSendMode === "end-of-turn"
            ? "Latest save is ready now. Future saves auto-send at turn end."
            : "Latest save is ready here until you send it."
          : props.state.autoSendMode === "end-of-turn"
            ? "Saving auto-sends the latest prompt update at turn end."
            : "Saving keeps the latest prompt update here until you send it.";
  const collapsedStatusText = getCollapsedStatusText({
    hasPendingUpdate: props.state.hasPendingUpdate,
    hasPreview,
    autoSendMode: props.state.autoSendMode,
  });
  const previewLabel = getFlowPromptPreviewLabel({
    hasPendingUpdate: props.state.hasPendingUpdate,
    kind: preview?.kind ?? "raw",
  });
  const previewModeText = props.state.hasPendingUpdate
    ? "End of turn"
    : props.state.autoSendMode === "end-of-turn"
      ? "Auto-send on"
      : "Manual";
  const actionGridColumnsClassName = props.state.exists
    ? "sm:grid-cols-2 lg:grid-cols-4"
    : "sm:grid-cols-2";
  const autoSendControlClassName = props.state.exists
    ? "sm:col-span-2 lg:col-span-4"
    : "sm:col-span-2";
  const actionButtonClassName = "w-full justify-center gap-1.5 px-2.5";
  const handleAutoSendModeChange = (value: string) => {
    if (value === "off" || value === "end-of-turn") {
      props.onAutoSendModeChange(value);
    }
  };
  const handleCopyPath = () => {
    if (!canCopyPath) {
      return;
    }
    void copyToClipboard(props.state.path);
  };

  return (
    <div
      className="border-border bg-surface-primary border-t px-[15px]"
      data-component="FlowPromptingBanner"
    >
      <button
        type="button"
        onClick={props.onToggleCollapsed}
        className="group mx-auto flex w-full max-w-4xl min-w-0 items-center gap-2 px-2 py-1.5 text-xs transition-colors"
        aria-label={
          isCollapsed ? "Expand Flow Prompting composer" : "Collapse Flow Prompting composer"
        }
        data-testid={isCollapsed ? "flow-prompt-composer-strip" : undefined}
      >
        <FileText
          className={
            hasPreview
              ? "text-accent size-3.5"
              : "text-muted group-hover:text-secondary size-3.5 transition-colors"
          }
        />
        <span className="text-muted group-hover:text-secondary min-w-0 flex-1 truncate transition-colors">
          <span className="font-medium">Flow Prompting</span>
          <span>{` · ${collapsedStatusText}`}</span>
        </span>
        {hasPreview ? <span className="bg-accent h-1.5 w-1.5 shrink-0 rounded-full" /> : null}
        <div className="shrink-0">
          {isCollapsed ? (
            <ChevronRight className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
          ) : (
            <ChevronDown className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
          )}
        </div>
      </button>
      {!isCollapsed && (
        <div className="border-border mx-auto max-w-4xl space-y-2 border-t py-2">
          <div className="border-border-medium bg-background-secondary/60 rounded-md border px-2.5 py-2">
            <div className="flex flex-col gap-2.5">
              <div className="text-foreground flex items-center gap-2 text-sm font-medium">
                <FileText className="h-4 w-4 shrink-0" />
                Flow Prompting
              </div>
              {/*
                Keep the status copy full-width and move the long file path behind an explicit
                copy action so the Flow Prompting controls stay readable while saves surface
                their preview immediately below.
              */}
              <div className="min-w-0 space-y-1">
                <p className="text-muted text-[11px] leading-4">{statusText}</p>
                {props.error ? <p className="text-xs text-red-400">{props.error}</p> : null}
              </div>
              {/*
                Keep the controls in their own grid so medium-width chat panes do not force the
                buttons to fight the title row or overflow between breakpoints.
              */}
              <div className={cn("grid gap-1.5", actionGridColumnsClassName)}>
                <div
                  className={cn(
                    "border-border-medium bg-background grid gap-1.5 rounded-md border px-2 py-1.5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center",
                    autoSendControlClassName
                  )}
                >
                  <span className="text-muted shrink-0 text-[11px] font-medium tracking-wide uppercase">
                    Auto-send
                  </span>
                  <Select
                    value={props.state.autoSendMode}
                    onValueChange={handleAutoSendModeChange}
                    disabled={isAutoSendChanging}
                  >
                    <SelectTrigger className="border-border-medium bg-background w-full text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="end-of-turn">End-of-turn</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="secondary"
                  size="xs"
                  className={actionButtonClassName}
                  onClick={props.onSendNow}
                  disabled={!hasPreview || isSendingNow}
                >
                  <Send className="h-3.5 w-3.5" />
                  {isSendingNow ? "Sending…" : "Send now"}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className={actionButtonClassName}
                  onClick={handleCopyPath}
                  disabled={!canCopyPath}
                >
                  {copied ? (
                    <ClipboardCheck className="h-3.5 w-3.5" />
                  ) : (
                    <Clipboard className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied path" : "Copy path"}
                </Button>
                {props.state.exists ? (
                  <>
                    <Button
                      variant="secondary"
                      size="xs"
                      className={actionButtonClassName}
                      onClick={props.onOpen}
                    >
                      <SquarePen className="h-3.5 w-3.5" />
                      Open prompt
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      className={actionButtonClassName}
                      onClick={props.onDisable}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Disable
                    </Button>
                  </>
                ) : null}
              </div>
              {preview ? (
                <div className="border-border-medium bg-background rounded-md border">
                  <div className="border-border-medium flex items-center justify-between gap-2 border-b px-2.5 py-1">
                    <div className="text-foreground text-[11px] leading-none font-medium">
                      {previewLabel}
                    </div>
                    <div className="text-muted text-[10px] font-medium tracking-wide uppercase">
                      {previewModeText}
                    </div>
                  </div>
                  <div className="max-h-44 overflow-y-auto px-2.5 py-1.5">
                    {preview.kind === "diff" ? (
                      renderFlowPromptDiffPreview(preview.content, props.state.path)
                    ) : (
                      <UserMessageContent content={preview.content} variant="queued" />
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
