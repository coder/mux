import React from "react";
import { ChevronDown, ChevronRight, FileText, Send, SquarePen, Trash2 } from "lucide-react";
import type { FlowPromptAutoSendMode } from "@/common/constants/flowPrompting";
import type { FlowPromptState } from "@/common/orpc/types";
import { Button } from "@/browser/components/Button/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { UserMessageContent } from "@/browser/features/Messages/UserMessageContent";

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

function getFlowPromptPreviewDisplay(
  previewText: string | null | undefined
): FlowPromptPreviewDisplay | null {
  if (typeof previewText !== "string" || previewText.trim().length === 0) {
    return null;
  }

  const diffPrefix = "Latest flow prompt changes:\n```diff\n";
  const contentsPrefix = "Current flow prompt contents:\n```md\n";
  const emptyText = "The flow prompt file is now empty.";

  const diffIndex = previewText.indexOf(diffPrefix);
  if (diffIndex !== -1) {
    return {
      kind: "diff",
      content: previewText.slice(diffIndex + "Latest flow prompt changes:\n".length).trim(),
    };
  }

  const contentsIndex = previewText.indexOf(contentsPrefix);
  if (contentsIndex !== -1) {
    const contentStart = contentsIndex + contentsPrefix.length;
    const closingFenceIndex = previewText.lastIndexOf("\n```");

    return {
      kind: "contents",
      content:
        closingFenceIndex >= contentStart
          ? previewText.slice(contentStart, closingFenceIndex)
          : previewText.slice(contentStart),
    };
  }

  const emptyIndex = previewText.indexOf(emptyText);
  if (emptyIndex !== -1) {
    return {
      kind: "cleared",
      content: previewText.slice(emptyIndex).trim(),
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

export const FlowPromptComposerCard: React.FC<FlowPromptComposerCardProps> = (props) => {
  const preview = getFlowPromptPreviewDisplay(props.state.updatePreviewText);
  const hasPreview = preview != null;
  const isAutoSendChanging = props.isUpdatingAutoSendMode === true;
  const isCollapsed = props.isCollapsed === true;
  const isSendingNow = props.isSendingNow === true;
  const statusText = props.state.hasPendingUpdate
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
  const handleAutoSendModeChange = (value: string) => {
    if (value === "off" || value === "end-of-turn") {
      props.onAutoSendModeChange(value);
    }
  };

  return (
    <div
      className="border-border bg-surface-primary border-t px-[15px]"
      data-component="FlowPromptingBanner"
    >
      <button
        type="button"
        onClick={props.onToggleCollapsed}
        className="group mx-auto flex w-full max-w-4xl items-center gap-2 px-2 py-1.5 text-xs transition-colors"
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
        <span className="text-muted group-hover:text-secondary transition-colors">
          <span className="font-medium">Flow Prompting</span>
          <span>{` · ${collapsedStatusText}`}</span>
        </span>
        {hasPreview ? <span className="bg-accent h-1.5 w-1.5 rounded-full" /> : null}
        <div className="ml-auto">
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
            <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                  <div className="text-foreground flex shrink-0 items-center gap-2 text-sm font-medium">
                    <FileText className="h-4 w-4 shrink-0" />
                    Flow Prompting
                  </div>
                  <div className="border-border-medium bg-background text-muted flex min-w-0 flex-1 items-center rounded-sm border px-1.5 py-0.5 text-[10px]">
                    <code className="block min-w-0 truncate">{props.state.path}</code>
                  </div>
                </div>
                <p className="text-muted mt-1 text-[11px] leading-4">{statusText}</p>
                {props.error ? <p className="mt-1 text-xs text-red-400">{props.error}</p> : null}
              </div>
              <div className="flex w-full flex-wrap items-center justify-end gap-1.5 lg:w-auto lg:shrink-0 lg:justify-start">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted shrink-0 text-[11px] font-medium tracking-wide uppercase">
                    Auto-send
                  </span>
                  <Select
                    value={props.state.autoSendMode}
                    onValueChange={handleAutoSendModeChange}
                    disabled={isAutoSendChanging}
                  >
                    <SelectTrigger className="border-border-medium bg-background w-32 text-[11px]">
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
                  className="gap-1.5 px-2.5"
                  onClick={props.onSendNow}
                  disabled={!hasPreview || isSendingNow}
                >
                  <Send className="h-3.5 w-3.5" />
                  {isSendingNow ? "Sending…" : "Send now"}
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  className="gap-1.5 px-2.5"
                  onClick={props.onOpen}
                >
                  <SquarePen className="h-3.5 w-3.5" />
                  Open prompt
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1.5 px-2.5"
                  onClick={props.onDisable}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Disable
                </Button>
              </div>
            </div>
            {preview ? (
              <div className="border-border-medium bg-background mt-2 rounded-md border">
                <div className="border-border-medium flex items-center justify-between gap-2 border-b px-2.5 py-1">
                  <div className="text-foreground text-[11px] leading-none font-medium">
                    {previewLabel}
                  </div>
                  <div className="text-muted text-[10px] font-medium tracking-wide uppercase">
                    {previewModeText}
                  </div>
                </div>
                <div className="max-h-44 overflow-y-auto px-2.5 py-1.5">
                  <UserMessageContent content={preview.content} variant="queued" />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
