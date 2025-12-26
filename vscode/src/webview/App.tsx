import React, { useEffect, useMemo, useRef, useState } from "react";

import type { DisplayedMessage } from "mux/common/types/message";
import { createClient } from "mux/common/orpc/client";

import { ProviderOptionsProvider } from "mux/browser/contexts/ProviderOptionsContext";
import { SettingsProvider } from "mux/browser/contexts/SettingsContext";
import { APIProvider } from "mux/browser/contexts/API";
import { ThemeProvider } from "mux/browser/contexts/ThemeContext";
import { TooltipProvider } from "mux/browser/components/ui/tooltip";
import { Button } from "mux/browser/components/ui/button";
import { useAutoScroll } from "mux/browser/hooks/useAutoScroll";
import { StreamingMessageAggregator } from "mux/browser/utils/messages/StreamingMessageAggregator";

import type { ExtensionToWebviewMessage, UiConnectionStatus, UiWorkspace } from "./protocol";
import { ChatComposer } from "./ChatComposer";
import { DisplayedMessageRenderer } from "./DisplayedMessageRenderer";
import { createVscodeOrpcLink } from "./createVscodeOrpcLink";
import type { VscodeBridge } from "./vscodeBridge";

interface Notice {
  id: string;
  level: "info" | "error";
  message: string;
}

function formatConnectionStatus(status: UiConnectionStatus | null): string {
  if (!status) {
    return "Loading mux…";
  }

  const parts: string[] = [];

  if (status.mode === "api") {
    parts.push("Connected to mux server");
    if (status.baseUrl) {
      parts.push(status.baseUrl);
    }
  } else {
    parts.push("Using local file access");
    if (status.baseUrl) {
      parts.push(`Server: ${status.baseUrl}`);
    }
  }

  if (status.error) {
    parts.push(status.error);
  }

  return parts.join("\n");
}

function pickWorkspaceCreatedAt(workspace: UiWorkspace | undefined): string {
  // StreamingMessageAggregator expects a timestamp string (backend contract: always present).
  // Default to epoch to preserve stable ordering if we ever get legacy workspace metadata.
  return workspace?.createdAt ?? new Date(0).toISOString();
}

export function App(props: { bridge: VscodeBridge }): JSX.Element {
  const bridge = props.bridge;

  const apiClient = useMemo(() => {
    const link = createVscodeOrpcLink(bridge);
    return createClient(link);
  }, [bridge]);

  const [connectionStatus, setConnectionStatus] = useState<UiConnectionStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<UiWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  const workspacesRef = useRef<UiWorkspace[]>([]);

  const aggregatorRef = useRef<StreamingMessageAggregator | null>(null);
  const [displayedMessages, setDisplayedMessages] = useState<DisplayedMessage[]>([]);


  const { contentRef, innerRef, handleScroll, markUserInteraction, jumpToBottom } = useAutoScroll();

  const jumpToBottomRef = useRef(jumpToBottom);
  jumpToBottomRef.current = jumpToBottom;


  // Keep a stable monotonic counter for notice IDs.
  const noticeSeqRef = useRef(0);

  const pushNotice = (notice: { level: Notice["level"]; message: string }) => {
    noticeSeqRef.current += 1;
    const id = `notice-${noticeSeqRef.current}`;
    setNotices((prev) => [...prev, { id, level: notice.level, message: notice.message }]);
  };

  const canChat = Boolean(connectionStatus?.mode === "api" && selectedWorkspaceId);

  useEffect(() => {
    const unsubscribe = bridge.onMessage((raw) => {
      if (!raw || typeof raw !== "object" || !("type" in raw)) {
        return;
      }

      const type = (raw as { type?: unknown }).type;
      if (typeof type !== "string") {
        return;
      }

      // ORPC messages are handled by the ORPC link.
      if (type.startsWith("orpc")) {
        return;
      }

      const msg = raw as ExtensionToWebviewMessage;

      switch (msg.type) {
        case "connectionStatus":
          setConnectionStatus(msg.status);
          return;
        case "workspaces":
          workspacesRef.current = msg.workspaces;
          setWorkspaces(msg.workspaces);
          return;
        case "setSelectedWorkspace": {
          setSelectedWorkspaceId(msg.workspaceId);

          // The webview retains React state when hidden, so clear stale transcript
          // when no workspace is selected.
          if (!msg.workspaceId) {
            aggregatorRef.current = null;
            setDisplayedMessages([]);
            setNotices([]);
          }

          return;
        }
        case "chatReset": {
          const workspace = workspacesRef.current.find((w) => w.id === msg.workspaceId);
          const createdAt = pickWorkspaceCreatedAt(workspace);
          aggregatorRef.current = new StreamingMessageAggregator(createdAt, msg.workspaceId, workspace?.unarchivedAt);
          setDisplayedMessages([]);
          setNotices([]);
          jumpToBottomRef.current();
          return;
        }
        case "chatEvent": {
          if (!aggregatorRef.current) {
            const workspace = workspacesRef.current.find((w) => w.id === msg.workspaceId);
            const createdAt = pickWorkspaceCreatedAt(workspace);
            aggregatorRef.current = new StreamingMessageAggregator(createdAt, msg.workspaceId, workspace?.unarchivedAt);
          }

          aggregatorRef.current.handleMessage(msg.event);
          setDisplayedMessages(aggregatorRef.current.getDisplayedMessages());
          return;
        }
        case "uiNotice": {
          pushNotice({ level: msg.level, message: msg.message });
          return;
        }
        case "debugProbe":
          bridge.debugLog("debugProbe", msg);
          return;
        default:
          bridge.debugLog("unhandled extension message", msg);
      }
    });

    bridge.postMessage({ type: "ready" });

    return unsubscribe;
    // Only depend on the bridge instance; other state is read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  const onRefresh = () => {
    bridge.postMessage({ type: "refreshWorkspaces" });
  };

  const onConfigure = () => {
    bridge.postMessage({ type: "configureConnection" });
  };

  const onOpenWorkspace = () => {
    if (!selectedWorkspaceId) {
      return;
    }

    bridge.postMessage({ type: "openWorkspace", workspaceId: selectedWorkspaceId });
  };


  return (
    <APIProvider client={apiClient}>
      <SettingsProvider>
        <ProviderOptionsProvider>
          <ThemeProvider forcedTheme="dark">
            <TooltipProvider>
          <div className="flex h-screen flex-col">
            <div className="border-b border-border bg-background-secondary p-3">
              <div className="text-muted whitespace-pre-wrap text-xs">{formatConnectionStatus(connectionStatus)}</div>

              <div className="mt-3 flex items-center gap-2">
                <select
                  className="border-input bg-background text-foreground flex-1 rounded-md border px-2 py-1 text-sm"
                  value={selectedWorkspaceId ?? ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    bridge.postMessage({ type: "selectWorkspace", workspaceId: value ? value : null });
                  }}
                >
                  <option value="" disabled>
                    {workspaces.length > 0 ? "Select workspace…" : "No workspaces found"}
                  </option>
                  {workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.label}
                    </option>
                  ))}
                </select>

                <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
                  Refresh
                </Button>
                <Button type="button" size="sm" onClick={onOpenWorkspace} disabled={!selectedWorkspaceId}>
                  Open
                </Button>
              </div>

              <div className="mt-2">
                <Button type="button" variant="outline" size="sm" onClick={onConfigure}>
                  Configure Connection
                </Button>
              </div>
            </div>

            <div
              ref={contentRef}
              className="flex-1 overflow-y-auto p-3"
              onScroll={handleScroll}
              onWheel={markUserInteraction}
              onMouseDown={markUserInteraction}
              onTouchStart={markUserInteraction}
            >
              <div ref={innerRef}>
                {displayedMessages.map((msg) => (
                  <DisplayedMessageRenderer key={msg.id} message={msg} workspaceId={selectedWorkspaceId} />
                ))}

                {notices.map((notice) => (
                  <div
                    key={notice.id}
                    className={
                      notice.level === "error"
                        ? "mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                        : "mt-3 rounded-md border border-border-medium bg-background-secondary px-3 py-2 text-sm"
                    }
                  >
                    {notice.message}
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-border bg-background-secondary p-3">
              {selectedWorkspaceId ? (
                <ChatComposer
                  key={selectedWorkspaceId}
                  workspaceId={selectedWorkspaceId}
                  disabled={!canChat}
                  placeholder={canChat ? "Message mux…" : "Chat requires mux server connection."}
                  aggregator={aggregatorRef.current}
                  onSendComplete={jumpToBottom}
                  onNotice={pushNotice}
                />
              ) : (
                <div className="text-muted text-sm">Select a mux workspace to chat.</div>
              )}
            </div>
          </div>
            </TooltipProvider>
          </ThemeProvider>
        </ProviderOptionsProvider>
      </SettingsProvider>
    </APIProvider>
  );
}
