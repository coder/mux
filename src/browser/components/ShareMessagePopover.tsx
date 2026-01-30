import React, { useState, useEffect, useRef, useCallback } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  HelpIndicator,
} from "@/browser/components/ui/tooltip";
import { Button } from "@/browser/components/ui/button";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Link2,
  Loader2,
  Lock,
  PenTool,
  Trash2,
} from "lucide-react";
import { CopyIcon } from "@/browser/components/icons/CopyIcon";
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
import { SHARE_EXPIRATION_KEY, SHARE_SIGNING_KEY } from "@/common/constants/storage";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useLinkSharingEnabled } from "@/browser/contexts/TelemetryEnabledContext";
import { useAPI } from "@/browser/contexts/API";
import type { SigningCapabilities } from "@/common/orpc/schemas";

/** Encryption info tooltip shown next to share headers */
const EncryptionBadge = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <HelpIndicator className="text-[11px]">?</HelpIndicator>
    </TooltipTrigger>
    <TooltipContent className="max-w-[240px]">
      <p className="flex items-center gap-1.5 font-medium">
        <Lock aria-hidden="true" className="h-3 w-3" />
        End-to-end encrypted
      </p>
      <p className="text-muted-foreground mt-1 text-[11px]">
        Content is encrypted in your browser (AES-256-GCM). The key stays in the URL fragment and is
        never sent to the server.
      </p>
    </TooltipContent>
  </Tooltip>
);

/** Signing status badge - interactive button with full signing info tooltip */
interface SigningBadgeProps {
  /** Whether signing is/was enabled for this share */
  signed: boolean;
  /** Signing capabilities from backend */
  capabilities: SigningCapabilities | null;
  /** Whether signing is globally enabled */
  signingEnabled: boolean;
  /** Toggle signing on/off */
  onToggleSigning?: () => void;
  /** Callback to retry key detection (only shown when no key) */
  onRetryKeyDetection?: () => void;
}

/** Truncate public key for display */
function truncatePublicKey(key: string): string {
  // Format: "ssh-ed25519 AAAA...XXXX comment"
  const parts = key.split(" ");
  if (parts.length < 2) return key;
  const keyType = parts[0];
  const keyData = parts[1];
  if (keyData.length <= 16) return key;
  return `${keyType} ${keyData.slice(0, 8)}...${keyData.slice(-8)}`;
}

const SigningBadge = ({
  signed,
  capabilities,
  signingEnabled,
  onToggleSigning,
  onRetryKeyDetection,
}: SigningBadgeProps) => {
  const hasKey = Boolean(capabilities?.publicKey);
  const hasEncryptedKey = capabilities?.error?.hasEncryptedKey ?? false;

  // Color states:
  // - blue = signed/enabled with key
  // - yellow/warning = encrypted key found but unusable
  // - muted = disabled or no key at all
  const isActive = signed || (signingEnabled && hasKey);
  const iconColor = isActive ? "text-blue-400" : hasEncryptedKey ? "text-yellow-500" : "text-muted";

  // Determine status header content
  const getStatusHeader = (): React.ReactNode => {
    if (signed) {
      return (
        <span className="flex items-center gap-1.5">
          <Check aria-hidden="true" className="h-3 w-3" />
          Signed
        </span>
      );
    }
    if (signingEnabled && hasKey) return "Signing enabled";
    if (hasEncryptedKey) {
      return (
        <span className="flex items-center gap-1.5">
          <AlertTriangle aria-hidden="true" className="h-3 w-3" />
          Key requires passphrase
        </span>
      );
    }
    return "Signing disabled";
  };

  // Build tooltip content with full signing info
  const tooltipContent = (
    <div className="space-y-1.5">
      {/* Status header */}
      <p className="font-medium">{getStatusHeader()}</p>

      {/* Show signing details when key is available */}
      {hasKey && capabilities && (
        <div className="text-muted-foreground space-y-0.5 text-[10px]">
          {capabilities.githubUser && <p>GitHub: @{capabilities.githubUser}</p>}
          {capabilities.publicKey && (
            <p className="font-mono">{truncatePublicKey(capabilities.publicKey)}</p>
          )}
        </div>
      )}

      {/* Encrypted key warning message */}
      {!hasKey && hasEncryptedKey && (
        <p className="text-muted-foreground text-[10px]">
          Use an unencrypted key file, or ensure your SSH agent (e.g. 1Password) is running and
          SSH_AUTH_SOCK is set
          {onRetryKeyDetection && (
            <>
              {" · "}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryKeyDetection();
                }}
                className="text-foreground underline hover:no-underline"
              >
                Retry
              </button>
            </>
          )}
        </p>
      )}

      {/* No key message + retry */}
      {!hasKey && !hasEncryptedKey && (
        <p className="text-muted-foreground text-[10px]">
          No signing key found
          {onRetryKeyDetection && (
            <>
              {" · "}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryKeyDetection();
                }}
                className="text-foreground underline hover:no-underline"
              >
                Retry
              </button>
            </>
          )}
        </p>
      )}

      {/* Docs link - always visible */}
      <a
        href="https://mux.coder.com/workspaces/sharing"
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground block text-[10px] underline"
        onClick={(e) => e.stopPropagation()}
      >
        Learn more
      </a>
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onToggleSigning}
          disabled={!hasKey}
          tabIndex={-1}
          className={cn(
            "flex items-center justify-center rounded p-0.5 transition-colors",
            hasKey ? "hover:bg-muted/50 cursor-pointer" : "cursor-default",
            iconColor
          )}
          aria-label={signingEnabled ? "Disable signing" : "Enable signing"}
        >
          <PenTool className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[240px]">{tooltipContent}</TooltipContent>
    </Tooltip>
  );
};

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

type ShareMessagePopoverProps = {
  model?: string;
  thinking?: string;
  disabled?: boolean;
  /** Workspace name used for uploaded filename (e.g., "my-workspace" -> "my-workspace.md") */
  workspaceName?: string;

  /** Optional tooltip for the trigger button (useful for header-level actions). */
  tooltip?: string;
  /** Optional test id for the trigger button. */
  dataTestId?: string;
  /** Optional override for the uploaded filename. */
  fileNameOverride?: string;
} & (
  | {
      content: string;
      getContent?: never;
    }
  | {
      content?: string;
      getContent: () => string;
    }
);

export const ShareMessagePopover: React.FC<ShareMessagePopoverProps> = (props) => {
  // Hide share button when user explicitly disabled telemetry
  const linkSharingEnabled = useLinkSharingEnabled();
  const { api } = useAPI();

  const disabled = props.disabled ?? false;
  const model = props.model;
  const thinking = props.thinking;
  const workspaceName = props.workspaceName;
  const tooltip = props.tooltip;
  const dataTestId = props.dataTestId;
  const fileNameOverride = props.fileNameOverride;

  // For conversation shares, content can be generated lazily on popover open.
  // Keep a resolved copy so cache keys + uploads use a stable string.
  const [resolvedContent, setResolvedContent] = useState(() => props.content ?? "");

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

  // If content is provided directly (message-level shares), keep resolvedContent in sync.
  useEffect(() => {
    if (typeof props.content === "string") {
      setResolvedContent(props.content);
    }
  }, [props.content]);

  // Load cached data when resolved content changes.
  useEffect(() => {
    if (resolvedContent) {
      const cached = getShareData(resolvedContent);
      setLocalShareData(cached ?? null);
    } else {
      setLocalShareData(null);
    }
  }, [resolvedContent]);

  // Auto-upload when popover opens, no cached data exists, and signing capabilities are loaded
  useEffect(() => {
    const canAutoUpload =
      isOpen &&
      resolvedContent &&
      !shareData &&
      !isUploading &&
      !error &&
      signingCapabilitiesLoaded;

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

  function sanitizeFileName(name: string): string {
    const safeName = name
      .trim()
      .replaceAll(/[/\\]/g, "-")
      .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
      .replaceAll(/-+/g, "-");

    return safeName.length > 0 ? safeName : "message";
  }

  // Derive filename: allow override, otherwise prefer workspaceName.
  const getFileName = (): string => {
    if (fileNameOverride?.trim()) {
      const safeOverride = sanitizeFileName(fileNameOverride);
      return safeOverride.endsWith(".md") ? safeOverride : `${safeOverride}.md`;
    }

    if (workspaceName) {
      return `${sanitizeFileName(workspaceName)}.md`;
    }

    return "message.md";
  };

  // Upload with preferred expiration and optional signing
  const handleShare = async () => {
    if (!resolvedContent || isUploading) return;

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
          signature = await api.signing.signMessage({ content: resolvedContent });
        } catch (signErr) {
          console.warn("Failed to sign share content, uploading without signature:", signErr);
          // Continue without signature - don't fail the upload
        }
      }

      const result = await uploadToMuxMd(
        resolvedContent,
        {
          name: getFileName(),
          type: "text/markdown",
          size: new TextEncoder().encode(resolvedContent).length,
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
        cachedAt: Date.now(),
        signed: Boolean(signature),
      };

      // Cache the share data
      setShareData(resolvedContent, data);
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
      updateShareExpiration(resolvedContent, newExpiration);
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
      removeShareData(resolvedContent);
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
        removeShareData(resolvedContent);

        // Request a mux.md signature envelope from the backend if signing is now enabled.
        let signature: SignatureEnvelope | undefined;
        if (newSigningEnabled && signingCapabilities?.publicKey && api) {
          try {
            signature = await api.signing.signMessage({ content: resolvedContent });
          } catch {
            // Continue without signature
          }
        }

        // Re-upload with current expiration preference
        const preferred = getPreferredExpiration();
        const ms = expirationToMs(preferred);
        const expiresAt = ms ? new Date(Date.now() + ms) : undefined;

        const result = await uploadToMuxMd(
          resolvedContent,
          {
            name: getFileName(),
            type: "text/markdown",
            size: new TextEncoder().encode(resolvedContent).length,
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
          cachedAt: Date.now(),
          signed: Boolean(signature),
        };

        setShareData(resolvedContent, data);
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
    if (open) {
      setError(null);

      // For lazy content (conversation shares), compute the content when the popover opens.
      // We also sync-load cached share data here so the auto-upload effect doesn't fire
      // unnecessarily before cache lookup completes.
      if (props.getContent) {
        try {
          const nextContent = props.getContent();
          setResolvedContent(nextContent);
          setLocalShareData(nextContent ? (getShareData(nextContent) ?? null) : null);
        } catch (err) {
          console.error("Failed to generate share content:", err);
          setResolvedContent("");
          setLocalShareData(null);
          setError(err instanceof Error ? err.message : "Failed to generate content");
        }
      }
    }

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

  const ariaLabel = tooltip ?? (isAlreadyShared ? "Already shared" : "Share");

  const triggerButton = (
    <Button
      variant="ghost"
      size="icon"
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={cn(
        "flex h-6 w-6 items-center justify-center [&_svg]:size-3.5",
        isAlreadyShared ? "text-blue-400" : "text-placeholder"
      )}
    >
      <Link2 />
    </Button>
  );

  const trigger = tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="center">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  ) : (
    <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
  );

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      {trigger}
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
