import { COMPACTED_EMOJI, IDLE_COMPACTED_EMOJI } from "@/common/constants/ui";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { useStartHere } from "@/browser/hooks/useStartHere";
import type { DisplayedMessage } from "@/common/types/message";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { Clipboard, ClipboardCheck, FileText, ListStart } from "lucide-react";
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

  const content = message.content;
  const isStreaming = message.isStreaming;
  const isCompacted = message.isCompacted;
  const isStreamingCompaction = isStreaming && isCompacting;

  // Use Start Here hook for final assistant messages
  const {
    openModal,
    buttonLabel,
    disabled: startHereDisabled,
    modal,
  } = useStartHere(workspaceId, content, isCompacted);

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard(clipboardWriteText);

  // Keep only Copy button visible (most common action)
  // Kebab menu saves horizontal space by collapsing less-used actions into a single ⋮ button
  const buttons: ButtonConfig[] = isStreaming
    ? []
    : [
        {
          label: copied ? "Copied" : "Copy",
          onClick: () => void copyToClipboard(content),
          icon: copied ? <ClipboardCheck /> : <Clipboard />,
        },
      ];

  if (!isStreaming) {
    buttons.push({
      label: buttonLabel,
      onClick: openModal,
      disabled: startHereDisabled,
      tooltip: "Replace all chat history with this message",
      icon: <ListStart />,
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
        <pre className="text-text bg-code-bg m-0 rounded-sm p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {content}
        </pre>
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
          <span className="text-plan-mode bg-plan-mode/10 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
            {isIdleCompacted
              ? `${IDLE_COMPACTED_EMOJI} idle-compacted`
              : `${COMPACTED_EMOJI} compacted`}
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

      {modal}
    </>
  );
};
