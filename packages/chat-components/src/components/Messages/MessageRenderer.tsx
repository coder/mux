import React from "react";
import type { DisplayedMessage } from "@/types";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ReasoningMessage } from "./ReasoningMessage";
import { GenericToolCall } from "../tools/GenericToolCall";

interface MessageRendererProps {
  message: DisplayedMessage;
  className?: string;
}

/**
 * Routes message types to appropriate components for shared/read-only rendering.
 */
export const MessageRenderer: React.FC<MessageRendererProps> = ({ message, className }) => {
  switch (message.type) {
    case "user":
      return <UserMessage message={message} className={className} />;
    case "assistant":
      return <AssistantMessage message={message} className={className} />;
    case "tool":
      return <GenericToolCall message={message} className={className} />;
    case "reasoning":
      return <ReasoningMessage message={message} className={className} />;
    case "stream-error":
      return <StreamErrorMessage message={message} className={className} />;
    case "history-hidden":
      return <HistoryHiddenMessage message={message} className={className} />;
    case "workspace-init":
      return <InitMessage message={message} className={className} />;
    case "plan-display":
      return <PlanDisplayMessage message={message} className={className} />;
    default: {
      // Exhaustive check
      const _exhaustive: never = message;
      console.error("Unknown message type", _exhaustive);
      return null;
    }
  }
};

// Simple inline components for less common message types

import type {
  DisplayedStreamErrorMessage,
  DisplayedHistoryHiddenMessage,
  DisplayedInitMessage,
  DisplayedPlanMessage,
} from "@/types";
import { AlertTriangle, EyeOff, FolderOpen, FileText } from "lucide-react";
import { cn } from "@/utils/cn";
import { MarkdownRenderer } from "./MarkdownRenderer";

const StreamErrorMessage: React.FC<{ message: DisplayedStreamErrorMessage; className?: string }> = ({
  message,
  className,
}) => (
  <div className={cn("my-2 p-3 bg-red-500/10 border border-red-500/30 rounded", className)}>
    <div className="flex items-center gap-2 text-red-500 text-sm font-medium mb-1">
      <AlertTriangle className="h-4 w-4" />
      Error
    </div>
    <div className="text-sm text-red-400">{message.error}</div>
  </div>
);

const HistoryHiddenMessage: React.FC<{ message: DisplayedHistoryHiddenMessage; className?: string }> = ({
  message,
  className,
}) => (
  <div className={cn("my-2 p-2 text-center text-muted text-sm", className)}>
    <EyeOff className="inline h-4 w-4 mr-1" />
    {message.hiddenCount} message{message.hiddenCount !== 1 ? "s" : ""} hidden
  </div>
);

const InitMessage: React.FC<{ message: DisplayedInitMessage; className?: string }> = ({
  message,
  className,
}) => (
  <div className={cn("my-2 p-3 bg-accent/30 rounded text-sm", className)}>
    <div className="flex items-center gap-2 text-muted mb-1">
      <FolderOpen className="h-4 w-4" />
      Workspace initialized
    </div>
    <div className="text-xs text-muted">
      {message.workspacePath} • {message.model}
    </div>
  </div>
);

const PlanDisplayMessage: React.FC<{ message: DisplayedPlanMessage; className?: string }> = ({
  message,
  className,
}) => (
  <div className={cn("my-2 p-3 bg-plan-mode/10 border border-plan-mode/30 rounded", className)}>
    <div className="flex items-center gap-2 text-plan-mode text-sm font-medium mb-2">
      <FileText className="h-4 w-4" />
      Plan: {message.path}
    </div>
    <MarkdownRenderer content={message.content} />
  </div>
);
