import React from "react";
import { FileText, X } from "lucide-react";

export interface ChatAttachment {
  id: string;
  url: string;
  mediaType: string;
  filename?: string;
}

interface ChatAttachmentsProps {
  attachments: ChatAttachment[];
  /** If omitted, attachments are displayed read-only (no remove button). */
  onRemove?: (id: string) => void;
}

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

export const ChatAttachments: React.FC<ChatAttachmentsProps> = (props) => {
  if (props.attachments.length === 0) return null;

  const handleRemove = props.onRemove;

  return (
    <div className="flex flex-wrap gap-2 py-2">
      {props.attachments.map((attachment) => {
        const baseMediaType = getBaseMediaType(attachment.mediaType);
        const isImage = baseMediaType.startsWith("image/");

        if (isImage) {
          return (
            <div
              key={attachment.id}
              className="border-border-light bg-dark group grid h-20 w-20 overflow-hidden rounded border"
            >
              <img
                src={attachment.url}
                alt="Attached image"
                className="pointer-events-none col-start-1 row-start-1 h-full w-full object-cover"
              />
              {handleRemove && (
                <button
                  onClick={() => handleRemove(attachment.id)}
                  title="Remove attachment"
                  className="col-start-1 row-start-1 m-0.5 flex h-5 w-5 cursor-pointer items-center justify-center self-start justify-self-end rounded-full border-0 bg-black/70 p-0 text-sm leading-none text-white hover:bg-black/90"
                  aria-label="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        }

        const label =
          attachment.filename ?? (baseMediaType === "application/pdf" ? "PDF" : baseMediaType);

        return (
          <div
            key={attachment.id}
            className="border-border-light bg-dark flex max-w-[260px] items-center gap-2 rounded border px-2 py-1"
          >
            <FileText className="h-4 w-4 shrink-0 text-[var(--color-subtle)]" />
            <span className="truncate text-xs text-[var(--color-subtle)]">{label}</span>
            {handleRemove && (
              <button
                onClick={() => handleRemove(attachment.id)}
                title="Remove attachment"
                className="ml-auto flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-[var(--color-subtle)] hover:bg-black/40"
                aria-label="Remove attachment"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
