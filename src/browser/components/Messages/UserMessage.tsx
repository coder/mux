import React from "react";
import type { FilePart } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import type { ButtonConfig } from "./MessageWindow";
import { MessageWindow } from "./MessageWindow";
import { UserMessageContent } from "./UserMessageContent";
import { TerminalOutput } from "./TerminalOutput";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { getEditableUserMessageText } from "@/browser/utils/messages/messageUtils";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import { Clipboard, ClipboardCheck, Pencil } from "lucide-react";

interface UserMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
  onEdit?: (messageId: string, content: string, fileParts?: FilePart[]) => void;
  isCompacting?: boolean;
  clipboardWriteText?: (data: string) => Promise<void>;
}

export const UserMessage: React.FC<UserMessageProps> = ({
  message,
  className,
  onEdit,
  isCompacting,
  clipboardWriteText = copyToClipboard,
}) => {
  const isSynthetic = message.isSynthetic === true;
  const content = message.content;
  const [vimEnabled] = usePersistedState<boolean>(VIM_ENABLED_KEY, false, { listener: true });

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

  // Copy to clipboard with feedback
  const { copied, copyToClipboard } = useCopyToClipboard(clipboardWriteText);

  const handleEdit = () => {
    if (onEdit && !isLocalCommandOutput && !isSynthetic) {
      const editText = getEditableUserMessageText(message);
      onEdit(message.historyId, editText, message.fileParts);
    }
  };

  // Keep Copy and Edit buttons visible (most common actions)
  // Kebab menu saves horizontal space by collapsing less-used actions
  const buttons: ButtonConfig[] = [
    ...(onEdit && !isLocalCommandOutput && !isSynthetic
      ? [
          {
            label: "Edit",
            onClick: handleEdit,
            disabled: isCompacting,
            icon: <Pencil />,
            tooltip: isCompacting
              ? `Cannot edit while compacting (${formatKeybind(vimEnabled ? KEYBINDS.INTERRUPT_STREAM_VIM : KEYBINDS.INTERRUPT_STREAM_NORMAL)} to cancel)`
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

  // If it's a local command output, render with TerminalOutput

  const label = isSynthetic ? (
    <span className="bg-muted/20 text-muted rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase">
      synthetic
    </span>
  ) : null;
  if (isLocalCommandOutput) {
    return (
      <MessageWindow
        label={label}
        message={message}
        buttons={buttons}
        className={className}
        variant="user"
      >
        <TerminalOutput output={extractedOutput} isError={false} />
      </MessageWindow>
    );
  }

  return (
    <MessageWindow
      label={label}
      message={message}
      buttons={buttons}
      className={className}
      variant="user"
    >
      <UserMessageContent
        content={content}
        commandPrefix={message.commandPrefix}
        reviews={message.reviews}
        fileParts={message.fileParts}
        variant="sent"
      />
    </MessageWindow>
  );
};
