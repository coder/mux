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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";

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

function stripLeadingNextHeadingSection(body: string): string {
  const nextHeadingPrefix = "Current Next heading:\n";
  if (!body.startsWith(nextHeadingPrefix)) {
    return body;
  }

  const fencedSection = body.slice(nextHeadingPrefix.length);
  const openingFenceLineEnd = fencedSection.indexOf("\n");
  if (openingFenceLineEnd === -1) {
    return body;
  }

  const openingFenceLine = fencedSection.slice(0, openingFenceLineEnd);
  const openingFenceMatch = /^(?<fence>`{3,}|~{3,})[a-z0-9_-]*$/i.exec(openingFenceLine);
  const openingFence = openingFenceMatch?.groups?.fence;
  if (!openingFence) {
    return body;
  }

  const closingFenceIndex = fencedSection.indexOf(`\n${openingFence}`, openingFenceLineEnd + 1);
  if (closingFenceIndex === -1) {
    return body;
  }

  return fencedSection.slice(closingFenceIndex + `\n${openingFence}`.length).replace(/^\n+/, "");
}

function extractLeadingLabeledFencedSection(body: string, label: string): string | null {
  const prefix = `${label}\n`;
  if (!body.startsWith(prefix)) {
    return null;
  }

  const fencedSection = body.slice(prefix.length);
  const openingFenceLineEnd = fencedSection.indexOf("\n");
  if (openingFenceLineEnd === -1) {
    return null;
  }

  const openingFenceLine = fencedSection.slice(0, openingFenceLineEnd);
  const openingFenceMatch = /^(?<fence>`{3,}|~{3,})[a-z0-9_-]*$/i.exec(openingFenceLine);
  const openingFence = openingFenceMatch?.groups?.fence;
  if (!openingFence) {
    return null;
  }

  const closingFenceIndex = fencedSection.indexOf(`\n${openingFence}`, openingFenceLineEnd + 1);
  if (closingFenceIndex === -1) {
    return null;
  }

  return fencedSection.slice(openingFenceLineEnd + 1, closingFenceIndex);
}

function getFlowPromptPreviewDisplay(
  previewText: string | null | undefined
): FlowPromptPreviewDisplay | null {
  if (typeof previewText !== "string" || previewText.trim().length === 0) {
    return null;
  }

  const emptyText = "The flow prompt file is now empty.";

  const firstSectionBreak = previewText.indexOf("\n\n");
  const secondSectionBreak =
    firstSectionBreak === -1 ? -1 : previewText.indexOf("\n\n", firstSectionBreak + 2);
  const body = stripLeadingNextHeadingSection(
    secondSectionBreak === -1 ? previewText : previewText.slice(secondSectionBreak + "\n\n".length)
  );

  const diffContent = extractLeadingLabeledFencedSection(body, "Latest flow prompt changes:");
  if (diffContent != null) {
    return {
      kind: "diff",
      content: diffContent,
    };
  }

  const contentsContent = extractLeadingLabeledFencedSection(body, "Current flow prompt contents:");
  if (contentsContent != null) {
    return {
      kind: "contents",
      content: contentsContent,
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

interface FlowPromptActionButtonProps {
  label: string;
  variant: "secondary" | "ghost";
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}

function FlowPromptActionButton(props: FlowPromptActionButtonProps): React.ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant={props.variant}
            size="xs"
            className="h-6 w-6 shrink-0 p-0 [&_svg]:h-3.5 [&_svg]:w-3.5"
            onClick={props.onClick}
            disabled={props.disabled}
            aria-label={props.label}
          >
            {props.icon}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center">
        {props.label}
      </TooltipContent>
    </Tooltip>
  );
}

export const FlowPromptComposerCard: React.FC<FlowPromptComposerCardProps> = (props) => {
  const preview = getFlowPromptPreviewDisplay(props.state.updatePreviewText);
  const hasPreview = preview != null;
  const { copied, copyToClipboard } = useCopyToClipboard();
  const canCopyPath = props.state.path.trim().length > 0;
  const isAutoSendChanging = props.isUpdatingAutoSendMode === true;
  const isCollapsed = props.isCollapsed === true;
  const isSendingNow = props.isSendingNow === true;
  const nextHeadingContent = props.state.nextHeadingContent?.trim() ?? "";

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
  const sendNowLabel = isSendingNow ? "Sending…" : "Send now";
  const copyPathLabel = copied ? "Copied path" : "Copy path";
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
        className="group mx-auto flex w-full max-w-4xl min-w-0 items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors"
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
        <span className="text-muted group-hover:text-secondary min-w-0 flex-1 truncate text-left transition-colors">
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
              {/*
                Keep the header/actions on one compact row, but let the helper copy span the full
                accessory width underneath so medium-length status text wraps against the whole
                container instead of collapsing into a narrow column beside the icon.
              */}
              <div className="grid gap-x-3 gap-y-1.5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="text-foreground h-4 w-4 shrink-0" />
                  <span className="text-foreground min-w-0 text-sm font-medium">
                    Flow Prompting
                  </span>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 md:flex-nowrap md:justify-end">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted shrink-0 text-[11px] font-medium tracking-wide uppercase">
                      Auto-send
                    </span>
                    <Select
                      value={props.state.autoSendMode}
                      onValueChange={handleAutoSendModeChange}
                      disabled={isAutoSendChanging}
                    >
                      <SelectTrigger className="border-border-medium bg-background w-28 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="end-of-turn">End-of-turn</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <FlowPromptActionButton
                    label={sendNowLabel}
                    variant="secondary"
                    onClick={props.onSendNow}
                    disabled={!hasPreview || isSendingNow}
                    icon={<Send className="h-3.5 w-3.5" />}
                  />
                  <FlowPromptActionButton
                    label={copyPathLabel}
                    variant="ghost"
                    onClick={handleCopyPath}
                    disabled={!canCopyPath}
                    icon={
                      copied ? (
                        <ClipboardCheck className="h-3.5 w-3.5" />
                      ) : (
                        <Clipboard className="h-3.5 w-3.5" />
                      )
                    }
                  />
                  {props.state.exists ? (
                    <>
                      <FlowPromptActionButton
                        label="Open prompt"
                        variant="secondary"
                        onClick={props.onOpen}
                        icon={<SquarePen className="h-3.5 w-3.5" />}
                      />
                      <FlowPromptActionButton
                        label="Disable"
                        variant="ghost"
                        onClick={props.onDisable}
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                      />
                    </>
                  ) : null}
                </div>
                <div
                  data-testid="flow-prompt-helper-row"
                  className="min-w-0 rounded-sm px-2 py-0.5 md:col-span-2"
                >
                  <p className="text-muted text-[11px] leading-4">{statusText}</p>
                  {props.error ? <p className="pt-1 text-xs text-red-400">{props.error}</p> : null}
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-foreground text-[11px] font-medium tracking-wide uppercase">
                    Next
                  </div>
                  <span className="text-muted text-[10px] leading-none">
                    Sent with every Flow Prompt update
                  </span>
                </div>
                <div className="border-border-medium bg-background rounded-md border px-3 py-2">
                  {nextHeadingContent.length > 0 ? (
                    <UserMessageContent content={nextHeadingContent} variant="queued" />
                  ) : (
                    <p className="text-muted text-xs leading-4">
                      Add a <code>Next</code> heading in the flow prompt file to steer what gets
                      sent alongside each update.
                    </p>
                  )}
                </div>
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
