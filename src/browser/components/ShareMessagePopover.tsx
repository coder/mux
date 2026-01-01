import React, { useState, useEffect, useRef, useCallback } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { Button } from "@/browser/components/ui/button";
import { Check, ExternalLink, Link2, Loader2, Trash2 } from "lucide-react";
import { CopyButton } from "@/browser/components/ui/CopyButton";

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
  /** Workspace name used for uploaded filename (e.g., "my-workspace" -> "my-workspace.md") */
  workspaceName?: string;
}

export const ShareMessagePopover: React.FC<ShareMessagePopoverProps> = ({
  content,
  model,
  thinking,
  disabled = false,
  workspaceName,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showUpdated, setShowUpdated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Current share data (from upload or cache)
  const [shareData, setLocalShareData] = useState<ShareData | null>(null);

  // Load cached data when content changes
  useEffect(() => {
    if (content) {
      const cached = getShareData(content);
      setLocalShareData(cached ?? null);
    }
  }, [content]);

  // Auto-upload when popover opens and no cached data exists
  useEffect(() => {
    if (isOpen && content && !shareData && !isUploading && !error) {
      void handleShare();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Auto-select URL text when share data becomes available
  useEffect(() => {
    if (shareData && urlInputRef.current) {
      // Small delay to ensure input is rendered
      requestAnimationFrame(() => {
        urlInputRef.current?.select();
      });
    }
  }, [shareData]);

  const isAlreadyShared = Boolean(shareData);

  // Get preferred expiration from localStorage
  const getPreferredExpiration = (): ExpirationValue => {
    return readPersistedState<ExpirationValue>(SHARE_EXPIRATION_KEY, "7d");
  };

  // Save preferred expiration to localStorage
  const savePreferredExpiration = (value: ExpirationValue) => {
    updatePersistedState(SHARE_EXPIRATION_KEY, value);
  };

  // Derive filename: prefer workspaceName, fallback to default
  const getFileName = (): string => {
    if (workspaceName) {
      // Sanitize workspace name for filename (remove unsafe chars)
      const safeName = workspaceName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
      return `${safeName}.md`;
    }
    return "message.md";
  };

  // Upload without expiration (optimistic), then allow setting expiration after
  const handleShare = async () => {
    if (!content || isUploading) return;

    setIsUploading(true);
    setError(null);

    try {
      const result = await uploadToMuxMd(content, {
        name: getFileName(),
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
    setShowUpdated(false);

    try {
      const ms = expirationToMs(value);
      const expiresAt = ms ? new Date(Date.now() + ms) : "never";
      const newExpiration = await updateMuxMdExpiration(data.id, data.mutateKey, expiresAt);

      // Update cache
      updateShareExpiration(content, newExpiration);
      setLocalShareData((prev) => (prev ? { ...prev, expiresAt: newExpiration } : null));

      // Save preference for future shares
      savePreferredExpiration(value);

      // Show success indicator briefly
      if (!silent) {
        setShowUpdated(true);
        setTimeout(() => setShowUpdated(false), 2000);
      }
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

      // Close the popover after successful delete
      setIsOpen(false);
    } catch (err) {
      console.error("Delete failed:", err);
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleOpenInBrowser = useCallback(() => {
    if (shareData?.url) {
      window.open(shareData.url, "_blank", "noopener,noreferrer");
    }
  }, [shareData?.url]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      // Reset transient state when closing
      setTimeout(() => {
        setError(null);
      }, 150);
    }
  };

  const currentExpiration = timestampToExpiration(shareData?.expiresAt);
  const isBusy = isUploading || isUpdating || isDeleting;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
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
      </PopoverTrigger>
      <PopoverContent side="top" align="start" collisionPadding={16} className="w-[280px] p-3">
        {!shareData ? (
          // Uploading state (auto-triggered on open)
          <div className="space-y-3">
            <div className="text-foreground text-xs font-medium">Share</div>

            {error ? (
              <>
                <div className="bg-destructive/10 text-destructive rounded px-2 py-1.5 text-[11px]">
                  {error}
                </div>
                <Button
                  onClick={() => void handleShare()}
                  disabled={isUploading}
                  className="h-7 w-full text-xs"
                >
                  Retry
                </Button>
              </>
            ) : (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="text-muted h-5 w-5 animate-spin" />
                <span className="text-muted ml-2 text-xs">Encrypting...</span>
              </div>
            )}

            <p className="text-muted text-center text-[10px]">
              End-to-end encrypted. Server never sees content.
            </p>
          </div>
        ) : (
          // Post-upload: show URL, expiration controls, and delete option
          <div className="space-y-3">
            <div className="text-foreground text-xs font-medium">Shared Link</div>

            {/* URL input with inline copy/open buttons */}
            <div className="border-border bg-background flex items-center gap-1 rounded border px-2 py-1.5">
              <input
                ref={urlInputRef}
                type="text"
                readOnly
                value={shareData.url}
                className="text-foreground min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none"
                data-testid="share-url"
                onFocus={(e) => e.target.select()}
              />
              <CopyButton text={shareData.url} className="share-copy-button" />
              <button
                onClick={handleOpenInBrowser}
                className="text-muted hover:text-foreground shrink-0 p-0.5 transition-colors"
                aria-label="Open in browser"
                data-testid="open-share-url"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
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

            {/* Success indicator on its own line */}
            {showUpdated && (
              <div className="flex items-center justify-center gap-1 text-[11px] text-green-500">
                <Check className="h-3.5 w-3.5" />
                Expiration updated
              </div>
            )}

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
