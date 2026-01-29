import { useEffect, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { addEphemeralMessage } from "@/browser/stores/WorkspaceStore";
import { createMuxMessage } from "@/common/types/message";
import type { StartupNotice } from "@/common/orpc/types";
import { cn } from "@/common/lib/utils";

function formatNoticeForChat(notice: StartupNotice): string {
  const lines = [notice.title, notice.message];
  if (notice.details && notice.details.length > 0) {
    lines.push("");
    lines.push("Details:");
    for (const detail of notice.details) {
      lines.push(`- ${detail}`);
    }
  }
  return lines.join("\n");
}

export function StartupNoticeBanner() {
  const { api } = useAPI();
  const { selectedWorkspace } = useWorkspaceContext();
  const [notice, setNotice] = useState<StartupNotice | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sentToChat, setSentToChat] = useState(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;

    const loadNotices = async () => {
      try {
        const notices = await api.server.getStartupNotices();
        if (!cancelled) {
          setNotice(notices[0] ?? null);
        }
      } catch {
        if (!cancelled) {
          setNotice(null);
        }
      }
    };

    void loadNotices();

    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!notice) return;
    setExpanded(false);
    setDismissed(false);
    setSentToChat(false);
  }, [notice]);

  if (!notice || dismissed) {
    return null;
  }

  const details = notice.details ?? [];
  const hasDetails = details.length > 0;
  const isWarning = notice.level === "warning";
  const iconClassName = isWarning ? "text-warning" : "text-info-yellow";
  const bannerClassName = isWarning
    ? "bg-warning/10 border-warning/30 text-warning"
    : "bg-info-yellow/10 border-info-yellow/30 text-info-yellow";

  const handleSendToChat = () => {
    if (!selectedWorkspace || sentToChat) return;
    const messageText = formatNoticeForChat(notice);
    const messageId = `${notice.id}-${Date.now()}`;
    const message = createMuxMessage(messageId, "assistant", messageText);
    addEphemeralMessage(selectedWorkspace.workspaceId, message);
    setSentToChat(true);
  };

  return (
    <div className={cn(bannerClassName, "flex flex-col gap-2 border-b px-4 py-2 text-sm")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {isWarning ? (
            <AlertTriangle className={cn(iconClassName, "size-4 shrink-0")} />
          ) : (
            <Info className={cn(iconClassName, "size-4 shrink-0")} />
          )}
          <div className="flex flex-col gap-1">
            <span className="font-medium">{notice.title}</span>
            <span>{notice.message}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasDetails ? (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="text-xs underline hover:no-underline"
            >
              {expanded ? "Hide details" : "View details"}
            </button>
          ) : null}
          {selectedWorkspace && !sentToChat ? (
            <button
              type="button"
              onClick={handleSendToChat}
              className="text-xs underline hover:no-underline"
            >
              Send to chat
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 p-1 transition-opacity hover:opacity-80"
            aria-label="Dismiss startup notice"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      {expanded && hasDetails ? (
        <ul className="ml-6 list-disc text-xs leading-relaxed">
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
