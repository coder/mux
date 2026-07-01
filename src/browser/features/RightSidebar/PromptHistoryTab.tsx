import React from "react";
import { Clipboard, CornerDownLeft, LocateFixed, MessageSquareText } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { formatTimestamp } from "@/browser/utils/ui/dateTime";
import {
  CUSTOM_EVENTS,
  createCustomEvent,
  type CustomEventPayloads,
} from "@/common/constants/events";
import { cn } from "@/common/lib/utils";
import { getPromptHistoryEntries, type PromptHistoryEntry } from "./promptHistoryEntries";

interface PromptHistoryTabProps {
  workspaceId: string;
}

export function PromptHistoryTab(props: PromptHistoryTabProps) {
  const workspaceState = useWorkspaceState(props.workspaceId);
  const entries = getPromptHistoryEntries(workspaceState.messages);

  const navigateToMessage = (historyId: string) => {
    // The transcript owns its scroll container, so the sidebar asks it to reveal
    // the message instead of reaching across the layout with a DOM query.
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.NAVIGATE_TO_TRANSCRIPT_MESSAGE, {
        workspaceId: props.workspaceId,
        historyId,
      })
    );
  };

  const insertIntoComposer = (entry: PromptHistoryEntry) => {
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, createPromptHistoryInsertPayload(entry))
    );
  };

  if (entries.length === 0) {
    return (
      <div className="text-muted flex h-full flex-col items-center justify-center px-5 text-center text-sm">
        <MessageSquareText aria-hidden="true" className="mb-3 h-5 w-5 opacity-70" />
        <p>No user prompts yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <div className="text-muted px-1 text-xs leading-5">
        {entries.length.toLocaleString()} prompt{entries.length === 1 ? "" : "s"} in this transcript
      </div>
      <div className="flex flex-col gap-2">
        {entries.map((entry, index) => (
          <PromptHistoryEntryCard
            key={entry.historyId}
            entry={entry}
            ordinal={index + 1}
            onNavigate={navigateToMessage}
            onInsert={insertIntoComposer}
          />
        ))}
      </div>
    </div>
  );
}

export function createPromptHistoryInsertPayload(
  entry: PromptHistoryEntry
): CustomEventPayloads[typeof CUSTOM_EVENTS.UPDATE_CHAT_INPUT] {
  return {
    text: entry.insertContent ?? entry.content,
    mode: "replace",
    fileParts: entry.fileParts ?? [],
    reviews: entry.reviews ?? [],
    muxMetadata: entry.muxMetadata,
  };
}

interface PromptHistoryEntryCardProps {
  entry: PromptHistoryEntry;
  ordinal: number;
  onNavigate: (historyId: string) => void;
  onInsert: (entry: PromptHistoryEntry) => void;
}

function PromptHistoryEntryCard(props: PromptHistoryEntryCardProps) {
  const timestamp = props.entry.timestamp ? formatTimestamp(props.entry.timestamp) : null;
  const accessoryLabel = props.entry.isSideQuestion
    ? "Side question"
    : (props.entry.commandPrefix ??
      (props.entry.fileCount > 0
        ? `${props.entry.fileCount.toLocaleString()} file${props.entry.fileCount === 1 ? "" : "s"}`
        : null));

  return (
    <article className="border-border-light bg-surface-secondary overflow-hidden rounded-md border">
      <button
        type="button"
        className={cn(
          "hover:bg-accent/40 block w-full px-3 py-2.5 text-left transition-colors",
          "focus-visible:ring-accent focus-visible:ring-1 focus-visible:outline-none"
        )}
        onClick={() => props.onNavigate(props.entry.historyId)}
      >
        <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
          <span className="text-muted shrink-0 text-[11px] tabular-nums">
            #{props.ordinal.toLocaleString()}
          </span>
          {timestamp && <span className="text-muted truncate text-[11px]">{timestamp}</span>}
        </div>
        {accessoryLabel && (
          <div className="text-accent mb-1 truncate text-[11px] font-medium">{accessoryLabel}</div>
        )}
        <p className="text-foreground max-h-20 overflow-hidden text-xs leading-5 whitespace-pre-wrap">
          {props.entry.content || "(attachments only)"}
        </p>
      </button>
      <div className="border-border-light flex items-center justify-end gap-1 border-t px-2 py-1">
        <PromptHistoryIconButton
          label="Copy prompt"
          onClick={() => void copyToClipboard(props.entry.content)}
        >
          <Clipboard aria-hidden="true" className="h-3.5 w-3.5" />
        </PromptHistoryIconButton>
        <PromptHistoryIconButton
          label="Insert into composer"
          onClick={() => props.onInsert(props.entry)}
        >
          <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5" />
        </PromptHistoryIconButton>
        <PromptHistoryIconButton
          label="Go to message"
          onClick={() => props.onNavigate(props.entry.historyId)}
        >
          <LocateFixed aria-hidden="true" className="h-3.5 w-3.5" />
        </PromptHistoryIconButton>
      </div>
    </article>
  );
}

interface PromptHistoryIconButtonProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

function PromptHistoryIconButton(props: PromptHistoryIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={props.label}
          className="text-muted hover:text-foreground hover:bg-accent/50 flex h-7 w-7 items-center justify-center rounded-sm transition-colors"
          onClick={props.onClick}
        >
          {props.children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{props.label}</TooltipContent>
    </Tooltip>
  );
}
