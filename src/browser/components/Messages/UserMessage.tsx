import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import type { ButtonConfig } from "./MessageWindow";
import { MessageWindow } from "./MessageWindow";
import { TerminalOutput } from "./TerminalOutput";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";
import { Clipboard, ClipboardCheck, Pencil } from "lucide-react";

interface UserMessageProps {
  message: DisplayedMessage & { type: "user" };
  className?: string;
  onEdit?: (messageId: string, content: string) => void;
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
    if (onEdit && !isLocalCommandOutput) {
      onEdit(message.historyId, content);
    }
  };

  // Keep Copy and Edit buttons visible (most common actions)
  // Kebab menu saves horizontal space by collapsing less-used actions
  const buttons: ButtonConfig[] = [
    ...(onEdit && !isLocalCommandOutput
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
  if (isLocalCommandOutput) {
    return (
      <MessageWindow
        label={null}
        message={message}
        buttons={buttons}
        className={className}
        variant="user"
      >
        <TerminalOutput output={extractedOutput} isError={false} />
      </MessageWindow>
    );
  }

  // Otherwise, render as normal user message
  return (
    <MessageWindow
      label={null}
      message={message}
      buttons={buttons}
      className={className}
      variant="user"
    >
      {content && (
        <pre className="font-primary m-0 leading-6 break-words whitespace-pre-wrap text-[var(--color-user-text)]">
          {content}
        </pre>
      )}
      {message.imageParts && message.imageParts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {message.imageParts.map((img, idx) => (
            <img
              key={idx}
              src={img.url}
              alt={`Attachment ${idx + 1}`}
              className="max-h-[300px] max-w-72 rounded-xl border border-[var(--color-attachment-border)] object-cover"
            />
          ))}
        </div>
      )}
    </MessageWindow>
  );
};
