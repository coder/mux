import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Trash2 } from "lucide-react";

import { CopyIcon } from "@/browser/components/icons/CopyIcon/CopyIcon";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { useAPI } from "@/browser/contexts/API";
import { copyToClipboard } from "@/browser/utils/clipboard";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { SHARE_EXPIRATION_KEY, SHARE_SIGNING_KEY } from "@/common/constants/storage";
import {
  deleteFromMuxMd,
  uploadToMuxMd,
  updateMuxMdExpiration,
  type FileInfo,
  type SignatureEnvelope,
} from "@/common/lib/muxMd";
import {
  EXPIRATION_OPTIONS,
  type ExpirationValue,
  expirationToMs,
  timestampToExpiration,
} from "@/common/lib/shareExpiration";
import type { MuxMessage } from "@/common/types/message";
import { buildChatJsonlForSharing } from "@/common/utils/messages/transcriptShare";
import type { SigningCapabilities } from "@/common/orpc/schemas";
import assert from "@/common/utils/assert";
import { EncryptionBadge, SigningBadge } from "../ShareSigningBadges/ShareSigningBadges";

interface ShareTranscriptDialogProps {
  workspaceId: string;
  workspaceName: string;
  /** Human-readable workspace title shown in the dialog header */
  workspaceTitle?: string;
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

export function ShareTranscriptDialog(props: ShareTranscriptDialogProps) {
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
  const [isDeleting, setIsDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Signing capabilities and enabled state (matching per-message sharing)
  const [signingCapabilities, setSigningCapabilities] = useState<SigningCapabilities | null>(null);
  const [signingCapabilitiesLoaded, setSigningCapabilitiesLoaded] = useState(false);
  const [signingEnabled, setSigningEnabled] = usePersistedState(SHARE_SIGNING_KEY, true);
  const [signed, setSigned] = useState(false);

  const urlInputRef = useRef<HTMLInputElement>(null);

  // Guards against cross-workspace leakage when users switch workspaces mid-upload.
  const uploadSeqRef = useRef(0);

  const clearSharedTranscriptState = useCallback(() => {
    setShareUrl(null);
    setShareId(null);
    setShareMutateKey(null);
    setShareExpiresAt(undefined);
    setSigned(false);
    setCopied(false);
  }, []);

  const isBusy = isUploading || isUpdatingExpiration || isDeleting;

  useEffect(() => {
    uploadSeqRef.current += 1;
    clearSharedTranscriptState();
    setError(null);
    setIsUploading(false);
    setIsUpdatingExpiration(false);
    setIsDeleting(false);
  }, [clearSharedTranscriptState, props.workspaceId]);

  // Load signing capabilities when the dialog first opens.
  // Defensive: tests and legacy mocks may provide a partial API client without signing endpoints.
  useEffect(() => {
    const signingApi = api?.signing;
    if (!props.open || signingCapabilitiesLoaded || !signingApi?.capabilities) {
      return;
    }

    void signingApi
      .capabilities({})
      .then(setSigningCapabilities)
      .catch(() => {
        // Signing unavailable – leave capabilities null
      })
      .finally(() => {
        setSigningCapabilitiesLoaded(true);
      });
  }, [api, props.open, signingCapabilitiesLoaded]);

  useEffect(() => {
    if (!props.open || !shareUrl) {
      return;
    }

    urlInputRef.current?.focus();
    urlInputRef.current?.select();
  }, [props.open, shareUrl]);

  // Retry key detection (user may have created a key after app launch).
  // Defensive: no-op if signing endpoints are unavailable in the injected API client.
  const handleRetryKeyDetection = async () => {
    if (!api?.signing?.clearIdentityCache || !api.signing.capabilities) return;
    try {
      await api.signing.clearIdentityCache({});
      const caps = await api.signing.capabilities({});
      setSigningCapabilities(caps);
    } catch {
      // Silently fail – capabilities stay as-is
    }
  };

  const handleGenerateLink = useCallback(async () => {
    if (isBusy) {
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

      // Request a signing envelope when signing is enabled
      let signature: SignatureEnvelope | undefined;
      if (signingEnabled && signingCapabilities?.publicKey && api?.signing?.signMessage) {
        try {
          signature = await api.signing.signMessage({ content: chatJsonl });
        } catch (signErr) {
          console.warn("Failed to sign transcript, uploading without signature:", signErr);
          // Continue without signature – don't fail the upload
        }
      }

      const sendOptions = getSendOptionsFromStorage(workspaceId);

      // Prefer the user-facing workspace title for uploaded filename when available.
      const fileInfo: FileInfo = {
        name: getTranscriptFileName(props.workspaceTitle ?? props.workspaceName),
        type: "application/x-ndjson",
        size: new TextEncoder().encode(chatJsonl).length,
        model: workspaceState.currentModel ?? sendOptions.model,
        thinking: workspaceState.currentThinkingLevel ?? sendOptions.thinkingLevel,
      };

      const result = await uploadToMuxMd(chatJsonl, fileInfo, {
        expiresAt: (() => {
          const preferred = readPersistedState<ExpirationValue>(SHARE_EXPIRATION_KEY, "never");
          const expMs = expirationToMs(preferred);
          return expMs ? new Date(Date.now() + expMs) : undefined;
        })(),
        signature,
      });
      if (uploadSeqRef.current === uploadSeq) {
        setShareUrl(result.url);
        setShareId(result.id);
        setShareMutateKey(result.mutateKey);
        setShareExpiresAt(result.expiresAt);
        setSigned(Boolean(signature));
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
  }, [
    api,
    includeToolOutput,
    isBusy,
    props.workspaceId,
    props.workspaceName,
    props.workspaceTitle,
    signingCapabilities,
    signingEnabled,
    store,
  ]);

  const handleUpdateExpiration = async (value: ExpirationValue) => {
    if (!shareId || !shareMutateKey || isBusy) return;

    // Capture the current upload sequence so we can discard the result if a new
    // link is generated (workspace switch or re-upload) before this resolves.
    const seq = uploadSeqRef.current;

    setIsUpdatingExpiration(true);
    try {
      const ms = expirationToMs(value);
      const expiresAtArg = ms ? new Date(Date.now() + ms) : "never";
      const newExpiration = await updateMuxMdExpiration(shareId, shareMutateKey, expiresAtArg);
      if (uploadSeqRef.current === seq) {
        setShareExpiresAt(newExpiration);
        updatePersistedState(SHARE_EXPIRATION_KEY, value);
      }
    } catch (err) {
      console.error("Update expiration failed:", err);
    } finally {
      if (uploadSeqRef.current === seq) {
        setIsUpdatingExpiration(false);
      }
    }
  };

  const handleDelete = useCallback(async () => {
    if (!shareId || !shareMutateKey || isDeleting) {
      return;
    }

    const seq = uploadSeqRef.current;
    assert(shareUrl, "Deleting a shared transcript requires a visible shareUrl");

    setIsDeleting(true);
    setError(null);

    try {
      await deleteFromMuxMd(shareId, shareMutateKey);
      if (uploadSeqRef.current === seq) {
        clearSharedTranscriptState();
      }
    } catch (err) {
      console.error("Delete transcript share failed:", err);
      if (uploadSeqRef.current === seq) {
        setError(err instanceof Error ? err.message : "Failed to delete shared transcript");
      }
    } finally {
      if (uploadSeqRef.current === seq) {
        setIsDeleting(false);
      }
    }
  }, [clearSharedTranscriptState, isDeleting, shareId, shareMutateKey, shareUrl]);

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
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent maxWidth="380px" showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            Share transcript
            <EncryptionBadge />
            <SigningBadge
              signed={signed}
              capabilities={signingCapabilities}
              signingEnabled={signingEnabled}
              onToggleSigning={() => setSigningEnabled(!signingEnabled)}
              onRetryKeyDetection={() => void handleRetryKeyDetection()}
            />
          </DialogTitle>
          {props.workspaceTitle && (
            <p className="text-muted truncate text-xs">{props.workspaceTitle}</p>
          )}
        </DialogHeader>

        <div className="space-y-3">
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
            disabled={isBusy}
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
                      disabled={isBusy}
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
                      disabled={isBusy}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Open</TooltipContent>
                </Tooltip>
                {shareMutateKey && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => void handleDelete()}
                        className="text-muted hover:bg-destructive/10 hover:text-destructive rounded p-1 transition-colors"
                        aria-label="Delete shared transcript link"
                        data-testid="delete-share-transcript-url"
                        disabled={isBusy}
                      >
                        {isDeleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                  </Tooltip>
                )}
              </div>

              {/* Expiration control */}
              <div className="flex items-center gap-2">
                <span className="text-muted text-[10px]">Expires:</span>
                <Select
                  value={timestampToExpiration(shareExpiresAt)}
                  onValueChange={(v) => void handleUpdateExpiration(v as ExpirationValue)}
                  disabled={isBusy}
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
      </DialogContent>
    </Dialog>
  );
}
