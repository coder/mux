import React from "react";
import { cn } from "@/common/lib/utils";
import type { DisplayedMessage } from "@/common/types/message";
import type { ButtonConfig } from "./MessageWindow";
import { MessageWindow } from "./MessageWindow";
import { UserMessageContent } from "./UserMessageContent";
import { GoalSyntheticMessageContent } from "./GoalSyntheticMessageContent";
import { MonitorWakeMessage, parseMonitorWakeMessage } from "./MonitorWakeMessage";
import { TerminalOutput } from "./TerminalOutput";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { copyToClipboard } from "@/browser/utils/clipboard";
import {
  buildEditingStateFromDisplayed,
  canEditDisplayedUserMessage,
  type EditingMessageState,
} from "@/browser/utils/chatEditing";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import {
  ChevronLeft,
  ChevronRight,
  Clipboard,
  ClipboardCheck,
  Pencil,
  Radio,
  Target,
} from "lucide-react";

/** Navigation info for navigating between user messages */
export interface UserMessageNavigation {
  /** History ID of the previous user message (undefined if this is the first) */
  prevUserMessageId?: string;
  /** History ID of the next user message (undefined if this is the last) */
  nextUserMessageId?: string;
  /** Callback to navigate to a specific message by history ID */
  onNavigate: (historyId: string) => void;
}

interface UserMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
  onEdit?: (message: EditingMessageState) => void;
  isCompacting?: boolean;
  clipboardWriteText?: (data: string) => Promise<void>;
  /** Navigation info for backward/forward between user messages */
  navigation?: UserMessageNavigation;
}

export const UserMessage: React.FC<UserMessageProps> = ({
  message,
  className,
  onEdit,
  isCompacting,
  clipboardWriteText = copyToClipboard,
  navigation,
}) => {
  const isSynthetic = message.isSynthetic === true;
  const isGoalContinuation = message.isGoalContinuation === true;
  const isBudgetLimitWrapup = message.isBudgetLimitWrapup === true;
  const content = message.content;
  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });
  const isMobileTouch =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;

  console.assert(
    typeof clipboardWriteText === "function",
    "UserMessage expects clipboardWriteText to be a callable function."
  );

  // Check if this is a local command output
  const isLocalCommandOutput =
    content.startsWith("<local-command-stdout>") && content.endsWith("</local-command-stdout>");

  // Extract the actual output if it's a local command
  const extractedOutput = isLocalCommandOutput
    ? content.slice("<local-command-stdout>".length, -"</local-command-stdout>".length).trim()
    : "";

  // Monitor wakes are queued synthetically by AgentSession and arrive as `<monitor-event …>`
  // XML so the model has structured context. Detect them here to render an inline system card
  // instead of leaking the raw XML to the user.
  const monitorWakeEvent = parseMonitorWakeMessage(content);

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard(clipboardWriteText);

  const canEdit = canEditDisplayedUserMessage(message);

  const handleEdit = () => {
    // Goal-synthetic messages keep raw model prompts available via Copy/JSON only.
    if (onEdit && canEdit) {
      onEdit(buildEditingStateFromDisplayed(message));
    }
  };

  // Navigation buttons - always reserve space to avoid layout shift
  // Only show when navigation prop is provided (indicates more than one user message)
  const showNavigation = navigation !== undefined;
  const hasPrev = navigation?.prevUserMessageId !== undefined;
  const hasNext = navigation?.nextUserMessageId !== undefined;

  // Keep Copy and Edit buttons visible (most common actions)
  // Navigation buttons appear first when there are multiple user messages
  const buttons: ButtonConfig[] = [
    // Navigation: backward (previous user message)
    ...(showNavigation
      ? [
          {
            label: "Previous message",
            onClick: hasPrev
              ? () => navigation.onNavigate(navigation.prevUserMessageId!)
              : undefined,
            disabled: !hasPrev,
            icon: <ChevronLeft className={!hasPrev ? "opacity-30" : undefined} />,
            tooltip: hasPrev ? "Go to previous message" : undefined,
          },
        ]
      : []),
    // Navigation: forward (next user message)
    ...(showNavigation
      ? [
          {
            label: "Next message",
            onClick: hasNext
              ? () => navigation.onNavigate(navigation.nextUserMessageId!)
              : undefined,
            disabled: !hasNext,
            icon: <ChevronRight className={!hasNext ? "opacity-30" : undefined} />,
            tooltip: hasNext ? "Go to next message" : undefined,
          },
        ]
      : []),
    ...(onEdit && canEdit
      ? [
          {
            label: "Edit",
            onClick: handleEdit,
            disabled: isCompacting,
            icon: <Pencil />,
            tooltip: isCompacting
              ? isMobileTouch
                ? "Cannot edit while compacting"
                : `Cannot edit while compacting (${formatKeybind(vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL)} to cancel)`
              : undefined,
          },
        ]
      : []),
    {
      label: copied ? "Copied" : "Copy",
      onClick: () => void copyToClipboard(content),
      icon: copied ? <ClipboardCheck /> : <Clipboard />,
    },
  ];

  let label: React.ReactNode = null;
  if (isBudgetLimitWrapup) {
    label = (
      <span className="bg-warning/10 text-warning flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
        <Target aria-hidden="true" className="h-3 w-3" />
        budget limit wrap-up
      </span>
    );
  } else if (isGoalContinuation) {
    label = (
      <span className="bg-muted/20 text-muted flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
        <Target aria-hidden="true" className="h-3 w-3" />
        goal continuation
      </span>
    );
  } else if (monitorWakeEvent) {
    label = (
      <span className="bg-muted/20 text-muted flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
        <Radio aria-hidden="true" className="h-3 w-3" />
        monitor
      </span>
    );
  } else if (isSynthetic) {
    label = (
      <span className="bg-muted/20 text-muted rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
        auto
      </span>
    );
  }
  const syntheticClassName = cn(
    className,
    isSynthetic && "opacity-70",
    (isGoalContinuation || isBudgetLimitWrapup) && "italic"
  );

  let renderedContent: React.ReactNode;
  if (monitorWakeEvent) {
    renderedContent = <MonitorWakeMessage event={monitorWakeEvent} />;
  } else if (isLocalCommandOutput) {
    renderedContent = <TerminalOutput output={extractedOutput} isError={false} />;
  } else if (isGoalContinuation || isBudgetLimitWrapup) {
    renderedContent = (
      <GoalSyntheticMessageContent
        content={content}
        kind={isBudgetLimitWrapup ? "budget-limit" : "continuation"}
      />
    );
  } else {
    renderedContent = (
      <UserMessageContent
        content={content}
        commandPrefix={message.commandPrefix}
        agentSkillSnapshot={message.agentSkill?.snapshot}
        inlineSkillSnapshots={message.inlineSkillSnapshots}
        reviews={message.reviews}
        fileParts={message.fileParts}
        variant="sent"
      />
    );
  }

  return (
    <MessageWindow
      label={label}
      message={message}
      buttons={buttons}
      className={syntheticClassName}
      variant="user"
    >
      {renderedContent}
    </MessageWindow>
  );
};
