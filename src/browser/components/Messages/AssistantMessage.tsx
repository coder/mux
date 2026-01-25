import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { useStartHere } from "@/browser/hooks/useStartHere";
import type { DisplayedMessage } from "@/common/types/message";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { Clipboard, ClipboardCheck, FileText, ListStart, Moon, Package } from "lucide-react";
import { ShareMessagePopover } from "@/browser/components/ShareMessagePopover";
import { useOptionalWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { Button } from "../ui/button";
import React, { useState } from "react";
import { CompactingMessageContent } from "./CompactingMessageContent";
import { CompactionBackground } from "./CompactionBackground";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { ButtonConfig } from "./MessageWindow";
import { MessageWindow } from "./MessageWindow";
import { ModelDisplay } from "./ModelDisplay";
import { TypewriterMarkdown } from "./TypewriterMarkdown";

interface AssistantMessageProps {
  message: DisplayedMessage & { type: "assistant" };
  className?: string;
  workspaceId?: string;
  isCompacting?: boolean;
  clipboardWriteText?: (data: string) => Promise<void>;
}

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  message,
  className,
  workspaceId,
  isCompacting = false,
  clipboardWriteText = copyToClipboard,
}) => {
  const [showRaw, setShowRaw] = useState(false);
  const workspaceContext = useOptionalWorkspaceContext();

  // Get workspace name from context for share filename
  const workspaceName = workspaceId
    ? workspaceContext?.workspaceMetadata.get(workspaceId)?.name
    : undefined;

  const content = message.content;
  const isStreaming = message.isStreaming;
  const isCompacted = message.isCompacted;
  const isStreamingCompaction = isStreaming && isCompacting;

  // Use Start Here hook for final assistant messages
  const {
    openModal: openStartHereModal,
    buttonLabel: startHereLabel,
    disabled: startHereDisabled,
    modal: startHereModal,
  } = useStartHere(workspaceId, content, isCompacted, {
    // Preserve legacy plan/exec markers so Start Here keeps plan→exec handoff for old history.
    sourceAgentId: message.agentId ?? message.mode,
  });

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard(clipboardWriteText);

  // Keep only Copy button visible (most common action)
  // Kebab menu saves horizontal space by collapsing less-used actions into a single ⋮ button
  const copyButton: ButtonConfig = {
    label: copied ? "Copied" : "Copy",
    onClick: () => void copyToClipboard(content),
    icon: copied ? <ClipboardCheck /> : <Clipboard />,
  };

  const buttons: ButtonConfig[] = isStreaming ? [] : [copyButton];

  if (!isStreaming) {
    buttons.push({
      label: startHereLabel,
      onClick: openStartHereModal,
      disabled: startHereDisabled,
      tooltip: "Replace all chat history with this message",
      icon: <ListStart />,
    });
    buttons.push({
      label: "Share",
      component: (
        <ShareMessagePopover
          content={content}
          model={message.model}
          disabled={!content}
          workspaceName={workspaceName}
        />
      ),
    });
    buttons.push({
      label: showRaw ? "Show Markdown" : "Show Text",
      onClick: () => setShowRaw(!showRaw),
      active: showRaw,
      icon: <FileText />,
    });
  }

  // Render appropriate content based on state
  const renderContent = () => {
    // Empty streaming state
    if (isStreaming && !content) {
      return <div className="font-primary text-secondary italic">Waiting for response...</div>;
    }

    // Streaming text gets typewriter effect
    if (isStreaming) {
      const contentElement = <TypewriterMarkdown deltas={[content]} isComplete={false} />;

      // Wrap streaming compaction in special container
      if (isStreamingCompaction) {
        return <CompactingMessageContent>{contentElement}</CompactingMessageContent>;
      }

      return contentElement;
    }

    // Completed text renders as static content
    return content ? (
      showRaw ? (
        <div className="relative">
          <pre className="text-text bg-code-bg m-0 rounded-sm p-2 pb-8 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {content}
          </pre>
          <div className="absolute right-2 bottom-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] [&_svg]:size-3.5"
              onClick={() => void copyToClipboard(content)}
            >
              {copied ? <ClipboardCheck /> : <Clipboard />}
              {copied ? "Copied" : "Copy to clipboard"}
            </Button>
          </div>
        </div>
      ) : (
        <MarkdownRenderer content={content} />
      )
    ) : null;
  };

  // Create label with model name and compacted indicator if applicable
  const renderLabel = () => {
    const modelName = message.model;
    const isCompacted = message.isCompacted;
    const isIdleCompacted = message.isIdleCompacted;

    return (
      <div className="flex items-center gap-2">
        {modelName && <ModelDisplay modelString={modelName} />}
        {isCompacted && (
          <span className="text-plan-mode bg-plan-mode/10 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
            {isIdleCompacted ? (
              <Moon aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Package aria-hidden="true" className="h-3 w-3" />
            )}
            <span>{isIdleCompacted ? "idle-compacted" : "compacted"}</span>
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      <MessageWindow
        label={renderLabel()}
        variant="assistant"
        message={message}
        buttons={buttons}
        className={className}
        backgroundEffect={isStreamingCompaction ? <CompactionBackground /> : undefined}
      >
        {renderContent()}
      </MessageWindow>

      {startHereModal}
    </>
  );
};
