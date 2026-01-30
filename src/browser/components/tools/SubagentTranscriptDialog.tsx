import React, { useEffect, useMemo, useState } from "react";
import type { DisplayedMessage, MuxMessage } from "@/common/types/message";
import type { ChatMuxMessage } from "@/common/orpc/types";
import { useAPI } from "@/browser/contexts/API";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/browser/components/ui/dialog";
import { ErrorBox, LoadingDots } from "./shared/ToolPrimitives";
import { MessageRenderer } from "@/browser/components/Messages/MessageRenderer";

interface SubagentTranscriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workspace that owns the transcript artifact index (usually the current workspace). */
  workspaceId?: string;
  /** Child task/workspace id whose transcript should be displayed. */
  taskId: string;
}

export const SubagentTranscriptDialog: React.FC<SubagentTranscriptDialogProps> = (props) => (
  <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent className="max-h-[80vh] max-w-5xl overflow-hidden">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span>Transcript</span>
          <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
            {props.taskId}
          </code>
        </DialogTitle>
      </DialogHeader>

      <SubagentTranscriptViewer workspaceId={props.workspaceId} taskId={props.taskId} />
    </DialogContent>
  </Dialog>
);

const SubagentTranscriptViewer: React.FC<{ workspaceId?: string; taskId: string }> = (props) => {
  const { api } = useAPI();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<MuxMessage[] | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    setMessages(null);

    if (!api) {
      setIsLoading(false);
      setError("API unavailable");
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const transcript = await api.workspace.getSubagentTranscript({
          taskId: props.taskId,
          workspaceId: props.workspaceId,
        });

        if (cancelled) return;

        setMessages(transcript);
        setIsLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        setIsLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [api, props.taskId, props.workspaceId]);

  const displayedMessages: DisplayedMessage[] | null = useMemo(() => {
    if (!messages) {
      return null;
    }

    // Use a dedicated aggregator instance so transcript rendering matches the main chat UI.
    // We do NOT pass workspaceId here: the transcript may refer to a cleaned-up subagent workspace,
    // and we want MessageRenderer to stay read-only.
    const aggregator = new StreamingMessageAggregator(new Date().toISOString());
    aggregator.setShowAllMessages(true);

    for (const msg of messages) {
      const event: ChatMuxMessage = { ...msg, type: "message" };
      aggregator.handleMessage(event);
    }

    return aggregator.getDisplayedMessages();
  }, [messages]);

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
      {error && <ErrorBox>{error}</ErrorBox>}

      <div className="min-h-0 flex-1 overflow-y-auto rounded bg-[var(--color-bg-secondary)] p-3">
        {isLoading ? (
          <div className="text-muted text-[11px] italic">
            Loading transcript
            <LoadingDots />
          </div>
        ) : displayedMessages ? (
          displayedMessages.length > 0 ? (
            <div className="flex flex-col gap-2">
              {displayedMessages.map((msg) => (
                <MessageRenderer key={msg.id} message={msg} />
              ))}
            </div>
          ) : (
            <div className="text-muted text-[11px] italic">Transcript is empty</div>
          )
        ) : error ? null : (
          <div className="text-muted text-[11px] italic">No transcript loaded</div>
        )}
      </div>
    </div>
  );
};
