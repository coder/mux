import React, { useState } from "react";
import { Clipboard, ClipboardCheck, FileText } from "lucide-react";
import { MessageWindow, type ButtonConfig } from "./MessageWindow";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { DisplayedAssistantMessage } from "@/types";

interface AssistantMessageProps {
  message: DisplayedAssistantMessage;
  className?: string;
}

/**
 * Assistant message component for shared/read-only rendering.
 */
export const AssistantMessage: React.FC<AssistantMessageProps> = ({ message, className }) => {
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const content = message.content;
  const isStreaming = message.isStreaming;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  const buttons: ButtonConfig[] = isStreaming
    ? []
    : [
        {
          label: copied ? "Copied" : "Copy",
          onClick: () => void copyToClipboard(),
          icon: copied ? (
            <ClipboardCheck className="h-3.5 w-3.5" />
          ) : (
            <Clipboard className="h-3.5 w-3.5" />
          ),
        },
        {
          label: showRaw ? "Show Markdown" : "Show Text",
          onClick: () => setShowRaw(!showRaw),
          active: showRaw,
          icon: <FileText className="h-3.5 w-3.5" />,
        },
      ];

  const renderContent = () => {
    if (isStreaming && !content) {
      return <div className="font-primary text-secondary italic">Waiting for response...</div>;
    }

    if (!content) return null;

    if (showRaw) {
      return (
        <pre className="text-text bg-code-bg m-0 rounded-sm p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {content}
        </pre>
      );
    }

    return <MarkdownRenderer content={content} />;
  };

  const renderLabel = () => {
    const modelName = message.model;
    return modelName ? (
      <span className="text-xs text-muted">{formatModelName(modelName)}</span>
    ) : null;
  };

  return (
    <MessageWindow
      label={renderLabel()}
      variant="assistant"
      message={message}
      buttons={buttons}
      className={className}
    >
      {renderContent()}
    </MessageWindow>
  );
};

/**
 * Format model name for display.
 * Simplifies common model names for readability.
 */
function formatModelName(model: string): string {
  // Remove common prefixes for cleaner display
  return model
    .replace(/^anthropic\./, "")
    .replace(/^openai\//, "")
    .replace(/-\d{8}$/, "") // Remove date suffixes
    .replace(/@.*$/, ""); // Remove version tags
}
