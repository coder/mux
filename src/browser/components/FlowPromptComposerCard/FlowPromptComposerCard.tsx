import React from "react";
import { FileText, SquarePen, Trash2 } from "lucide-react";
import type { FlowPromptState } from "@/common/orpc/types";
import { Button } from "@/browser/components/Button/Button";

interface FlowPromptComposerCardProps {
  state: FlowPromptState;
  error?: string | null;
  onOpen: () => void;
  onDisable: () => void;
}

export const FlowPromptComposerCard: React.FC<FlowPromptComposerCardProps> = (props) => {
  const statusText = props.state.hasPendingUpdate
    ? "Latest save queued after the current step. Use chat below for quick follow-ups."
    : "Keep durable guidance in the file while using chat below for one-off turns.";

  return (
    <div className="border-border-medium bg-background-secondary/80 w-full rounded-lg border px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-foreground flex items-center gap-2 text-sm font-medium">
            <FileText className="h-4 w-4 shrink-0" />
            Flow Prompting
          </div>
          <p className="text-muted mt-1 text-xs">{statusText}</p>
          <div className="bg-background text-muted mt-2 flex items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-[11px]">
            <code className="block min-w-0 truncate">{props.state.path}</code>
          </div>
          {props.error ? <p className="mt-2 text-xs text-red-400">{props.error}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
          <Button variant="secondary" size="xs" onClick={props.onOpen}>
            <SquarePen className="h-3.5 w-3.5" />
            Open flow prompt
          </Button>
          <Button variant="ghost" size="xs" onClick={props.onDisable}>
            <Trash2 className="h-3.5 w-3.5" />
            Disable
          </Button>
        </div>
      </div>
    </div>
  );
};
