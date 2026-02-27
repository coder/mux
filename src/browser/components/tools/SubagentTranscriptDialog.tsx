import React, { useEffect, useMemo, useState } from "react";
import type { DisplayedMessage, MuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { ChatMuxMessage } from "@/common/orpc/types";
import { useAPI } from "@/browser/contexts/API";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { ErrorBox, LoadingDots } from "./shared/ToolPrimitives";
import { MessageRenderer } from "@/browser/components/Messages/MessageRenderer";
import { ModelDisplay } from "@/browser/components/Messages/ModelDisplay";
import { getErrorMessage } from "@/common/utils/errors";

interface SubagentTranscriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workspace that owns the transcript artifact index (usually the current workspace). */
  workspaceId?: string;
  /** Child task/workspace id whose transcript should be displayed. */
  taskId: string;
}

export const SubagentTranscriptDialog: React.FC<SubagentTranscriptDialogProps> = (props) => {
  const [model, setModel] = useState<string | undefined>();
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>();

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[80vh] min-h-0 max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span>Transcript</span>
              <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
                {props.taskId}
              </code>
            </div>

            {(model !== undefined || thinkingLevel !== undefined) && (
              <div className="text-muted flex flex-wrap items-baseline gap-2 text-[11px] font-normal">
                {model && <ModelDisplay modelString={model} />}
                {thinkingLevel && (
                  <span className="inline-flex items-center rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] leading-none">
                    thinking: {thinkingLevel}
                  </span>
                )}
              </div>
            )}
          </DialogTitle>
        </DialogHeader>

        <SubagentTranscriptViewer
          open={props.open}
          workspaceId={props.workspaceId}
          taskId={props.taskId}
          setModel={setModel}
          setThinkingLevel={setThinkingLevel}
        />
      </DialogContent>
    </Dialog>
  );
};

const SubagentTranscriptViewer: React.FC<{
  open: boolean;
  workspaceId?: string;
  taskId: string;
  setModel?: (model: string | undefined) => void;
  setThinkingLevel?: (thinkingLevel: ThinkingLevel | undefined) => void;
}> = (props) => {
  const { api } = useAPI();

  const open = props.open;
  const workspaceId = props.workspaceId;
  const taskId = props.taskId;
  const setModel = props.setModel;
  const setThinkingLevel = props.setThinkingLevel;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<MuxMessage[] | null>(null);

  useEffect(() => {
    // TaskToolCall renders this dialog component for each completed task even while closed.
    // Avoid expensive disk/IPC transcript loads until the dialog is opened.
    if (!open) {
      return;
    }

    setIsLoading(true);
    setError(null);
    setMessages(null);
    setModel?.(undefined);
    setThinkingLevel?.(undefined);

    if (!api) {
      setIsLoading(false);
      setError("API unavailable");
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const transcript = await api.workspace.getSubagentTranscript({
          taskId,
          workspaceId,
        });

        if (cancelled) return;

        setMessages(transcript.messages);
        setModel?.(transcript.model);
        setThinkingLevel?.(transcript.thinkingLevel);
        setIsLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        setIsLoading(false);
        setError(getErrorMessage(err));
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [api, open, taskId, workspaceId, setModel, setThinkingLevel]);

  const displayedMessages: DisplayedMessage[] | null = useMemo(() => {
    if (!messages) {
      return null;
    }

    // Use a dedicated aggregator instance so transcript rendering matches the main chat UI.
    // We intentionally do not pass workspaceId to the aggregator: it persists some UI state to localStorage.
    // We DO pass workspaceId to MessageRenderer so nested "View transcript" tool calls can resolve
    // artifacts from the parent workspace that owns the transcript index (important after roll-up).
    const aggregator = new StreamingMessageAggregator(new Date().toISOString());
    aggregator.setShowAllMessages(true);

    for (const msg of messages) {
      const event: ChatMuxMessage = { ...msg, type: "message" };
      aggregator.handleMessage(event);
    }

    return aggregator.getDisplayedMessages();
  }, [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
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
                <MessageRenderer key={msg.id} message={msg} workspaceId={workspaceId} />
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
