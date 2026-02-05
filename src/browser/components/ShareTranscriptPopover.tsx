import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Link2, Loader2 } from "lucide-react";

import { CopyIcon } from "@/browser/components/icons/CopyIcon";
import { Button } from "@/browser/components/ui/button";
import { Checkbox } from "@/browser/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { useAPI } from "@/browser/contexts/API";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { SHARE_EXPIRATION_KEY } from "@/common/constants/storage";
import { uploadToMuxMd, updateMuxMdExpiration, type FileInfo } from "@/common/lib/muxMd";
import {
  EXPIRATION_OPTIONS,
  type ExpirationValue,
  expirationToMs,
  timestampToExpiration,
} from "@/common/lib/shareExpiration";
import { cn } from "@/common/lib/utils";
import type { MuxMessage } from "@/common/types/message";
import { buildChatJsonlForSharing } from "@/common/utils/messages/transcriptShare";

interface ShareTranscriptPopoverProps {
  workspaceId: string;
  workspaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getTranscriptFileName(workspaceName: string): string {
  const trimmed = workspaceName.trim();
  if (!trimmed) {
    return "chat.jsonl";
  }

  // Keep this consistent with existing share filename sanitization.
  // (mux.md expects `FileInfo.name` to be safe for display and download.)
  const safeName = trimmed
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!safeName) {
    return "chat.jsonl";
  }

  return `${safeName}-chat.jsonl`;
}

function transcriptContainsProposePlanToolCall(messages: MuxMessage[]): boolean {
  return messages.some(
    (msg) =>
      msg.role === "assistant" &&
      msg.parts.some((part) => part.type === "dynamic-tool" && part.toolName === "propose_plan")
  );
}

export function ShareTranscriptPopover(props: ShareTranscriptPopoverProps) {
  const store = useWorkspaceStoreRaw();
  const { api } = useAPI();

  const [includeToolOutput, setIncludeToolOutput] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [shareMutateKey, setShareMutateKey] = useState<string | null>(null);
  const [shareExpiresAt, setShareExpiresAt] = useState<number | undefined>();
  const [isUpdatingExpiration, setIsUpdatingExpiration] = useState(false);
  const [copied, setCopied] = useState(false);

  const urlInputRef = useRef<HTMLInputElement>(null);

  // Guards against cross-workspace leakage when users switch workspaces mid-upload.
  // (WorkspaceHeader can be reused across workspace changes.)
  const uploadSeqRef = useRef(0);

  useEffect(() => {
    uploadSeqRef.current += 1;
    setShareUrl(null);
    setShareId(null);
    setShareMutateKey(null);
    setShareExpiresAt(undefined);
    setError(null);
    setCopied(false);
    setIsUploading(false);
    setIsUpdatingExpiration(false);
  }, [props.workspaceId]);

  useEffect(() => {
    if (!props.open || !shareUrl) {
      return;
    }

    urlInputRef.current?.focus();
    urlInputRef.current?.select();
  }, [props.open, shareUrl]);

  const handleGenerateLink = useCallback(async () => {
    if (isUploading) {
      return;
    }

    const uploadSeq = uploadSeqRef.current + 1;
    uploadSeqRef.current = uploadSeq;

    setIsUploading(true);
    setError(null);

    try {
      const workspaceId = props.workspaceId;
      const workspaceState = store.getWorkspaceState(workspaceId);

      let planSnapshot: { path: string; content: string } | undefined;
      if (api && transcriptContainsProposePlanToolCall(workspaceState.muxMessages)) {
        try {
          const res = await api.workspace.getPlanContent({ workspaceId });
          if (res.success) {
            planSnapshot = { path: res.data.path, content: res.data.content };
          } else {
            console.warn("Failed to read plan content for transcript sharing:", res.error);
          }
        } catch (err) {
          console.warn("Failed to read plan content for transcript sharing:", err);
          // Ignore failures - plan content is optional for sharing.
        }
      }

      const chatJsonl = buildChatJsonlForSharing(workspaceState.muxMessages, {
        includeToolOutput,
        workspaceId,
        planSnapshot,
      });

      if (!chatJsonl) {
        if (uploadSeqRef.current === uploadSeq) {
          setError("No messages to share yet");
        }
        return;
      }

      const sendOptions = getSendOptionsFromStorage(workspaceId);

      const fileInfo: FileInfo = {
        name: getTranscriptFileName(props.workspaceName),
        type: "application/x-ndjson",
        size: new TextEncoder().encode(chatJsonl).length,
        model: workspaceState.currentModel ?? sendOptions.model,
        thinking: sendOptions.thinkingLevel,
      };

      const result = await uploadToMuxMd(chatJsonl, fileInfo, {
        expiresAt: (() => {
          const preferred = readPersistedState<ExpirationValue>(SHARE_EXPIRATION_KEY, "never");
          const expMs = expirationToMs(preferred);
          return expMs ? new Date(Date.now() + expMs) : undefined;
        })(),
      });
      if (uploadSeqRef.current === uploadSeq) {
        setShareUrl(result.url);
        setShareId(result.id);
        setShareMutateKey(result.mutateKey);
        setShareExpiresAt(result.expiresAt);
      }
    } catch (err) {
      console.error("Failed to share transcript:", err);
      if (uploadSeqRef.current === uploadSeq) {
        setError(err instanceof Error ? err.message : "Failed to upload");
      }
    } finally {
      if (uploadSeqRef.current === uploadSeq) {
        setIsUploading(false);
      }
    }
  }, [api, includeToolOutput, isUploading, props.workspaceId, props.workspaceName, store]);

  const handleUpdateExpiration = async (value: ExpirationValue) => {
    if (!shareId || !shareMutateKey) return;
    setIsUpdatingExpiration(true);
    try {
      const ms = expirationToMs(value);
      const expiresAtArg = ms ? new Date(Date.now() + ms) : "never";
      const newExpiration = await updateMuxMdExpiration(shareId, shareMutateKey, expiresAtArg);
      setShareExpiresAt(newExpiration);
      updatePersistedState(SHARE_EXPIRATION_KEY, value);
    } catch (err) {
      console.error("Update expiration failed:", err);
    } finally {
      setIsUpdatingExpiration(false);
    }
  };

  const handleCopy = useCallback(() => {
    if (!shareUrl) {
      return;
    }

    void copyToClipboard(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [shareUrl]);

  const handleOpenInBrowser = useCallback(() => {
    if (!shareUrl) {
      return;
    }

    window.open(shareUrl, "_blank", "noopener,noreferrer");
  }, [shareUrl]);

  const handleOpenChange = (open: boolean) => {
    props.onOpenChange(open);

    if (!open) {
      setError(null);
      setCopied(false);
    }
  };

  return (
    <Popover open={props.open} onOpenChange={handleOpenChange}>
      <Tooltip {...(props.open ? { open: false } : {})}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Share transcript"
              className={cn(
                "h-6 w-6 shrink-0 [&_svg]:h-3.5 [&_svg]:w-3.5",
                shareUrl ? "text-blue-400" : "text-muted hover:text-foreground"
              )}
            >
              <Link2 />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          Share transcript ({formatKeybind(KEYBINDS.SHARE_TRANSCRIPT)})
        </TooltipContent>
      </Tooltip>

      <PopoverContent side="bottom" align="end" collisionPadding={16} className="w-[320px] p-3">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-foreground text-xs font-medium">Share transcript</span>
          </div>

          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox
              checked={includeToolOutput}
              onCheckedChange={(checked) => setIncludeToolOutput(checked === true)}
            />
            <span className="text-muted-foreground text-xs">
              Include tool output (plans always included)
            </span>
          </label>

          <Button
            onClick={() => void handleGenerateLink()}
            disabled={isUploading}
            className="h-7 w-full text-xs"
          >
            {isUploading ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Uploading...
              </>
            ) : (
              "Generate link"
            )}
          </Button>

          {shareUrl && (
            <>
              <div className="border-border bg-background flex items-center gap-1 rounded border px-2 py-1.5">
                <input
                  ref={urlInputRef}
                  type="text"
                  readOnly
                  aria-label="Shared transcript URL"
                  value={shareUrl}
                  className="text-foreground min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none"
                  data-testid="share-transcript-url"
                  onFocus={(e) => e.target.select()}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleCopy}
                      className="text-muted hover:bg-muted/50 hover:text-foreground shrink-0 rounded p-1 transition-colors"
                      aria-label="Copy to clipboard"
                      data-testid="copy-share-transcript-url"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <CopyIcon className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{copied ? "Copied!" : "Copy"}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleOpenInBrowser}
                      className="text-muted hover:bg-muted/50 hover:text-foreground shrink-0 rounded p-1 transition-colors"
                      aria-label="Open in browser"
                      data-testid="open-share-transcript-url"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Open</TooltipContent>
                </Tooltip>
              </div>

              {/* Expiration control */}
              <div className="flex items-center gap-2">
                <span className="text-muted text-[10px]">Expires:</span>
                <Select
                  value={timestampToExpiration(shareExpiresAt)}
                  onValueChange={(v) => void handleUpdateExpiration(v as ExpirationValue)}
                  disabled={isUploading || isUpdatingExpiration}
                >
                  <SelectTrigger className="h-6 flex-1 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRATION_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isUpdatingExpiration && (
                  <Loader2 className="text-muted h-3.5 w-3.5 animate-spin" />
                )}
              </div>
            </>
          )}

          {error && (
            <div
              role="alert"
              className="bg-destructive/10 text-destructive rounded px-2 py-1.5 text-[11px]"
            >
              {error}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
