import React, { useState, useEffect, useRef, useCallback } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { Button } from "@/browser/components/Button/Button";
import { Check, ExternalLink, Link2, Loader2, Trash2 } from "lucide-react";
import { CopyIcon } from "@/browser/components/icons/CopyIcon/CopyIcon";
import { copyToClipboard } from "@/browser/utils/clipboard";

import {
  uploadToMuxMd,
  deleteFromMuxMd,
  updateMuxMdExpiration,
  type SignatureEnvelope,
} from "@/common/lib/muxMd";
import {
  getShareData,
  setShareData,
  removeShareData,
  updateShareExpiration,
  type ShareData,
} from "@/browser/utils/sharedUrlCache";
import { cn } from "@/common/lib/utils";
import {
  type ExpirationValue,
  EXPIRATION_OPTIONS,
  expirationToMs,
  timestampToExpiration,
  formatExpiration,
} from "@/common/lib/shareExpiration";
import { SHARE_EXPIRATION_KEY, SHARE_SIGNING_KEY } from "@/common/constants/storage";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useLinkSharingEnabled } from "@/browser/contexts/TelemetryEnabledContext";
import { useAPI } from "@/browser/contexts/API";
import type { SigningCapabilities } from "@/common/orpc/schemas";
import { EncryptionBadge, SigningBadge } from "../ShareSigningBadges/ShareSigningBadges";

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
  // Hide share button when user explicitly disabled telemetry
  const linkSharingEnabled = useLinkSharingEnabled();
  const { api } = useAPI();

  const [isOpen, setIsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showUpdated, setShowUpdated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Current share data (from upload or cache)
  const [shareData, setLocalShareData] = useState<ShareData | null>(null);

  // Signing capabilities and enabled state
  const [signingCapabilities, setSigningCapabilities] = useState<SigningCapabilities | null>(null);
  const [signingCapabilitiesLoaded, setSigningCapabilitiesLoaded] = useState(false);
  const [signingEnabled, setSigningEnabled] = usePersistedState(SHARE_SIGNING_KEY, true);

  // Load signing capabilities on first popover open
  useEffect(() => {
    if (isOpen && !signingCapabilitiesLoaded && api) {
      void api.signing
        .capabilities({})
        .then(setSigningCapabilities)
        .catch(() => {
          // Signing unavailable - leave capabilities null
        })
        .finally(() => {
          setSigningCapabilitiesLoaded(true);
        });
    }
  }, [isOpen, api, signingCapabilitiesLoaded]);

  // Load cached data when content changes
  useEffect(() => {
    if (content) {
      const cached = getShareData(content);
      setLocalShareData(cached ?? null);
    }
  }, [content]);

  // Auto-upload when popover opens, no cached data exists, and signing capabilities are loaded
  useEffect(() => {
    const canAutoUpload =
      isOpen && content && !shareData && !isUploading && !error && signingCapabilitiesLoaded;

    if (canAutoUpload) {
      void handleShare();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, signingCapabilitiesLoaded]);

  // Auto-select URL text when popover opens with share data or share completes
  useEffect(() => {
    if (isOpen && shareData && urlInputRef.current) {
      // Small delay to ensure input is rendered
      requestAnimationFrame(() => {
        urlInputRef.current?.select();
      });
    }
  }, [isOpen, shareData]);

  const isAlreadyShared = Boolean(shareData);

  // Get preferred expiration from localStorage
  const getPreferredExpiration = (): ExpirationValue => {
    return readPersistedState<ExpirationValue>(SHARE_EXPIRATION_KEY, "never");
  };

  // Save preferred expiration to localStorage
  const savePreferredExpiration = (value: ExpirationValue) => {
    updatePersistedState(SHARE_EXPIRATION_KEY, value);
  };

  // Retry key detection (user may have created a key after app launch)
  const handleRetryKeyDetection = async () => {
    if (!api) return;
    try {
      // Clear backend cache (will retry key loading on next capabilities call)
      await api.signing.clearIdentityCache({});
      // Re-fetch capabilities
      const caps = await api.signing.capabilities({});
      setSigningCapabilities(caps);
    } catch {
      // Silently fail - capabilities stay as-is
    }
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

  // Upload with preferred expiration and optional signing
  const handleShare = async () => {
    if (!content || isUploading) return;

    setIsUploading(true);
    setError(null);

    try {
      // Get preferred expiration and include in upload request
      const preferred = getPreferredExpiration();
      const ms = expirationToMs(preferred);
      const expiresAt = ms ? new Date(Date.now() + ms) : undefined;

      // Request a mux.md signature envelope from the backend when signing is enabled.
      let signature: SignatureEnvelope | undefined;
      if (signingEnabled && signingCapabilities?.publicKey && api) {
        try {
          signature = await api.signing.signMessage({ content });
        } catch (signErr) {
          console.warn("Failed to sign share content, uploading without signature:", signErr);
          // Continue without signature - don't fail the upload
        }
      }

      const result = await uploadToMuxMd(
        content,
        {
          name: getFileName(),
          type: "text/markdown",
          size: new TextEncoder().encode(content).length,
          model,
          thinking,
        },
        { expiresAt, signature }
      );

      const data: ShareData = {
        url: result.url,
        id: result.id,
        mutateKey: result.mutateKey,
        expiresAt: result.expiresAt,
        signed: Boolean(signature),
      };

      // Cache the share data
      setShareData(content, data);
      setLocalShareData(data);
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

  // Toggle signing and regenerate URL inline if already shared
  const handleToggleSigning = async () => {
    const newSigningEnabled = !signingEnabled;
    setSigningEnabled(newSigningEnabled);

    // If we have an existing share, regenerate with new signing state
    if (shareData?.mutateKey && !isUploading) {
      setIsUploading(true);
      setError(null);

      try {
        // Delete the old share
        await deleteFromMuxMd(shareData.id, shareData.mutateKey);
        removeShareData(content);

        // Request a mux.md signature envelope from the backend if signing is now enabled.
        let signature: SignatureEnvelope | undefined;
        if (newSigningEnabled && signingCapabilities?.publicKey && api) {
          try {
            signature = await api.signing.signMessage({ content });
          } catch {
            // Continue without signature
          }
        }

        // Re-upload with current expiration preference
        const preferred = getPreferredExpiration();
        const ms = expirationToMs(preferred);
        const expiresAt = ms ? new Date(Date.now() + ms) : undefined;

        const result = await uploadToMuxMd(
          content,
          {
            name: getFileName(),
            type: "text/markdown",
            size: new TextEncoder().encode(content).length,
            model,
            thinking,
          },
          { expiresAt, signature }
        );

        const data: ShareData = {
          url: result.url,
          id: result.id,
          mutateKey: result.mutateKey,
          expiresAt: result.expiresAt,
          signed: Boolean(signature),
        };

        setShareData(content, data);
        setLocalShareData(data);
      } catch (err) {
        console.error("Failed to regenerate share:", err);
        setError(err instanceof Error ? err.message : "Failed to update signing");
      } finally {
        setIsUploading(false);
      }
    }
  };

  const handleCopy = useCallback(() => {
    if (shareData?.url) {
      void copyToClipboard(shareData.url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }, [shareData?.url]);

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

  // Don't render the share button if link sharing is disabled or still loading
  if (linkSharingEnabled !== true) {
    return null;
  }

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
            <div className="flex items-center gap-1.5">
              <span className="text-foreground text-xs font-medium">Share</span>
              <EncryptionBadge />
              <SigningBadge
                signed={false}
                capabilities={signingCapabilities}
                signingEnabled={signingEnabled}
                onToggleSigning={() => setSigningEnabled(!signingEnabled)}
                onRetryKeyDetection={() => void handleRetryKeyDetection()}
              />
            </div>

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
              <div className="flex items-center justify-center py-3">
                <Loader2 className="text-muted h-4 w-4 animate-spin" />
                <span className="text-muted ml-2 text-xs">Encrypting...</span>
              </div>
            )}
          </div>
        ) : (
          // Post-upload: show URL, expiration controls, and delete option
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-foreground text-xs font-medium">Shared</span>
                <EncryptionBadge />
                <SigningBadge
                  signed={Boolean(shareData.signed)}
                  capabilities={signingCapabilities}
                  signingEnabled={signingEnabled}
                  onToggleSigning={() => void handleToggleSigning()}
                  onRetryKeyDetection={() => void handleRetryKeyDetection()}
                />
              </div>
              {shareData.mutateKey && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => void handleDelete()}
                      className="text-muted hover:bg-destructive/10 hover:text-destructive rounded p-1 transition-colors"
                      aria-label="Delete shared link"
                      disabled={isBusy}
                      tabIndex={-1}
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleCopy}
                    className="text-muted hover:bg-muted/50 hover:text-foreground shrink-0 rounded p-1 transition-colors"
                    aria-label="Copy to clipboard"
                    data-testid="copy-share-url"
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
                    data-testid="open-share-url"
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
              {/* Inline status: spinner while updating, checkmark on success */}
              {isUpdating && <Loader2 className="text-muted h-3.5 w-3.5 animate-spin" />}
              {showUpdated && <Check className="h-3.5 w-3.5 text-green-500" />}
            </div>

            {error && (
              <div className="bg-destructive/10 text-destructive rounded px-2 py-1.5 text-[11px]">
                {error}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
