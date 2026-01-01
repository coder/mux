import React, { useState, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { Button } from "@/browser/components/ui/button";
import { Clipboard, ClipboardCheck, ExternalLink, Link2, Loader2, Trash2 } from "lucide-react";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { uploadToMuxMd, deleteFromMuxMd, updateMuxMdExpiration } from "@/browser/lib/muxMd";
import {
  getShareData,
  setShareData,
  removeShareData,
  updateShareExpiration,
  type ShareData,
} from "@/browser/utils/sharedUrlCache";
import { cn } from "@/common/lib/utils";
import { SHARE_EXPIRATION_KEY } from "@/common/constants/storage";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";

/** Expiration options with human-readable labels */
const EXPIRATION_OPTIONS = [
  { value: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { value: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "never", label: "Never", ms: null },
] as const;

type ExpirationValue = (typeof EXPIRATION_OPTIONS)[number]["value"];

/** Convert expiration value to milliseconds from now, or undefined for "never" */
function expirationToMs(value: ExpirationValue): number | null {
  const opt = EXPIRATION_OPTIONS.find((o) => o.value === value);
  return opt?.ms ?? null;
}

/** Convert timestamp to expiration value (best fit) */
function timestampToExpiration(expiresAt: number | undefined): ExpirationValue {
  if (!expiresAt) return "never";
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "1h"; // Already expired, default to shortest
  // Find the closest option
  for (const opt of EXPIRATION_OPTIONS) {
    if (opt.ms && remaining <= opt.ms * 1.5) return opt.value;
  }
  return "never";
}

/** Format expiration for display */
function formatExpiration(expiresAt: number | undefined): string {
  if (!expiresAt) return "Never";
  const date = new Date(expiresAt);
  const now = Date.now();
  const diff = expiresAt - now;

  if (diff <= 0) return "Expired";
  if (diff < 60 * 60 * 1000) return `${Math.ceil(diff / (60 * 1000))}m`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.ceil(diff / (60 * 60 * 1000))}h`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.ceil(diff / (24 * 60 * 60 * 1000))}d`;
  return date.toLocaleDateString();
}

interface ShareMessagePopoverProps {
  content: string;
  model?: string;
  thinking?: string;
  disabled?: boolean;
  /** Visual variant: "message" for icon button (default), "plan" for plan chip style */
  variant?: "message" | "plan";
}

export const ShareMessagePopover: React.FC<ShareMessagePopoverProps> = ({
  content,
  model,
  thinking,
  disabled = false,
  variant = "message",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Current share data (from upload or cache)
  const [shareData, setLocalShareData] = useState<ShareData | null>(null);

  // Load cached data when content changes or popover opens
  useEffect(() => {
    if (content) {
      const cached = getShareData(content);
      setLocalShareData(cached ?? null);
    }
  }, [content, isOpen]);

  const isAlreadyShared = Boolean(shareData);
  const { copied, copyToClipboard } = useCopyToClipboard();

  // Get preferred expiration from localStorage
  const getPreferredExpiration = (): ExpirationValue => {
    return readPersistedState<ExpirationValue>(SHARE_EXPIRATION_KEY, "7d");
  };

  // Save preferred expiration to localStorage
  const savePreferredExpiration = (value: ExpirationValue) => {
    updatePersistedState(SHARE_EXPIRATION_KEY, value);
  };

  // Upload without expiration (optimistic), then allow setting expiration after
  const handleShare = async () => {
    if (!content || isUploading) return;

    setIsUploading(true);
    setError(null);

    try {
      const result = await uploadToMuxMd(content, {
        name: variant === "plan" ? "plan.md" : "message.md",
        type: "text/markdown",
        size: new TextEncoder().encode(content).length,
        model,
        thinking,
      });

      const data: ShareData = {
        url: result.url,
        id: result.id,
        mutateKey: result.mutateKey,
        expiresAt: result.expiresAt,
        cachedAt: Date.now(),
      };

      // Cache the share data
      setShareData(content, data);
      setLocalShareData(data);

      // If user has a preferred expiration, apply it automatically
      const preferred = getPreferredExpiration();
      if (preferred !== "never") {
        // Apply preferred expiration in background
        void handleUpdateExpiration(data, preferred, true);
      }
    } catch (err) {
      console.error("Share failed:", err);
      setError(err instanceof Error ? err.message : "Failed to upload");
    } finally {
      setIsUploading(false);
    }
  };

  // Update expiration on server and cache
  const handleUpdateExpiration = async (
    data: ShareData,
    value: ExpirationValue,
    silent = false
  ) => {
    if (!data.mutateKey) return;

    if (!silent) setIsUpdating(true);
    setError(null);

    try {
      const ms = expirationToMs(value);
      const expiresAt = ms ? new Date(Date.now() + ms) : "never";
      const newExpiration = await updateMuxMdExpiration(data.id, data.mutateKey, expiresAt);

      // Update cache
      updateShareExpiration(content, newExpiration);
      setLocalShareData((prev) => (prev ? { ...prev, expiresAt: newExpiration } : null));

      // Save preference for future shares
      savePreferredExpiration(value);
    } catch (err) {
      console.error("Update expiration failed:", err);
      if (!silent) {
        setError(err instanceof Error ? err.message : "Failed to update expiration");
      }
    } finally {
      if (!silent) setIsUpdating(false);
    }
  };

  // Delete from server and remove from cache
  const handleDelete = async () => {
    if (!shareData?.mutateKey) return;

    setIsDeleting(true);
    setError(null);

    try {
      await deleteFromMuxMd(shareData.id, shareData.mutateKey);

      // Remove from cache
      removeShareData(content);
      setLocalShareData(null);
    } catch (err) {
      console.error("Delete failed:", err);
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopy = () => {
    if (shareData?.url) {
      void copyToClipboard(shareData.url);
    }
  };

  const handleOpenInBrowser = () => {
    if (shareData?.url) {
      window.open(shareData.url, "_blank", "noopener,noreferrer");
    }
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      // Reset transient state when closing
      setTimeout(() => {
        setError(null);
      }, 150);
    }
  };

  // Plan chip styling (matches ProposePlanToolCall button style)
  const planChipClasses =
    "px-2 py-1 text-[10px] font-mono rounded-sm cursor-pointer transition-all duration-150 active:translate-y-px";

  const currentExpiration = timestampToExpiration(shareData?.expiresAt);
  const isBusy = isUploading || isUpdating || isDeleting;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {variant === "plan" ? (
          <button
            disabled={disabled}
            aria-label={isAlreadyShared ? "Already shared" : "Share"}
            className={cn(
              planChipClasses,
              "plan-chip-ghost hover:plan-chip-ghost-hover",
              isAlreadyShared && "text-blue-400",
              disabled && "cursor-not-allowed opacity-50"
            )}
          >
            {isAlreadyShared ? "Shared" : "Share"}
          </button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={isAlreadyShared ? "Already shared" : "Share"}
            className={cn(
              "flex h-6 w-6 items-center justify-center [&_svg]:size-3.5",
              isAlreadyShared ? "text-blue-400" : "text-placeholder"
            )}
          >
            <Link2 />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-3">
        {!shareData ? (
          // Pre-upload: show share button (no expiration selector - upload first)
          <div className="space-y-3">
            <div className="text-foreground text-xs font-medium">
              Share {variant === "plan" ? "Plan" : "Message"}
            </div>

            {error && (
              <div className="bg-destructive/10 text-destructive rounded px-2 py-1.5 text-[11px]">
                {error}
              </div>
            )}

            <Button
              onClick={() => void handleShare()}
              disabled={isUploading || !content}
              className="h-7 w-full text-xs"
            >
              {isUploading ? (
                <>
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  Encrypting...
                </>
              ) : (
                "Create Link"
              )}
            </Button>

            <p className="text-muted text-center text-[10px]">
              End-to-end encrypted. Server never sees content.
            </p>
          </div>
        ) : (
          // Post-upload: show URL, expiration controls, and delete option
          <div className="space-y-3">
            <div className="text-foreground text-xs font-medium">Shared Link</div>

            <div className="border-border bg-background rounded border p-2">
              <code
                className="text-foreground block font-mono text-[10px] break-all"
                data-testid="share-url"
              >
                {shareData.url}
              </code>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleCopy}
                className="h-7 flex-1 text-xs"
                variant="default"
                data-testid="copy-share-url"
              >
                {copied ? (
                  <>
                    <ClipboardCheck className="mr-1.5 h-3 w-3" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Clipboard className="mr-1.5 h-3 w-3" />
                    Copy
                  </>
                )}
              </Button>
              <Button
                onClick={handleOpenInBrowser}
                variant="outline"
                className="h-7 text-xs"
                data-testid="open-share-url"
              >
                <ExternalLink className="h-3 w-3" />
              </Button>
            </div>

            {/* Expiration control */}
            <div className="flex items-center gap-2">
              <span className="text-muted text-[10px]">Expires:</span>
              {shareData.mutateKey ? (
                <Select
                  value={currentExpiration}
                  onValueChange={(v) =>
                    void handleUpdateExpiration(shareData, v as ExpirationValue)
                  }
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
              ) : (
                <span className="text-foreground text-[10px]">
                  {formatExpiration(shareData.expiresAt)}
                </span>
              )}
              {isUpdating && <Loader2 className="h-3 w-3 animate-spin" />}
            </div>

            {error && (
              <div className="bg-destructive/10 text-destructive rounded px-2 py-1.5 text-[11px]">
                {error}
              </div>
            )}

            {/* Delete action */}
            {shareData.mutateKey && (
              <Button
                onClick={() => void handleDelete()}
                variant="ghost"
                className="text-destructive hover:text-destructive h-7 w-full text-xs"
                disabled={isBusy}
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-1.5 h-3 w-3" />
                    Delete shared link
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
