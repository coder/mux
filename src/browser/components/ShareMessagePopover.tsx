import React, { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { Button } from "@/browser/components/ui/button";
import { Clipboard, ClipboardCheck, ExternalLink, Link2, Loader2 } from "lucide-react";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { uploadToMuxMd, type UploadResult } from "@/common/lib/muxMd";
import { getSharedUrl, setSharedUrl } from "@/browser/utils/sharedUrlCache";

/** Expiration options with human-readable labels */
const EXPIRATION_OPTIONS = [
  { value: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { value: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "never", label: "Never", ms: null },
] as const;

type ExpirationValue = (typeof EXPIRATION_OPTIONS)[number]["value"];

interface ShareMessagePopoverProps {
  content: string;
  model?: string;
  thinking?: string;
  disabled?: boolean;
}

export const ShareMessagePopover: React.FC<ShareMessagePopoverProps> = ({
  content,
  model,
  thinking,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationValue>("7d");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Check for previously shared URL
  const cachedUrl = content ? getSharedUrl(content) : undefined;
  const isAlreadyShared = Boolean(cachedUrl);

  const { copied, copyToClipboard } = useCopyToClipboard();

  const handleShare = async () => {
    if (!content || isUploading) return;

    setIsUploading(true);
    setError(null);
    setUploadResult(null);

    try {
      const expirationOption = EXPIRATION_OPTIONS.find((opt) => opt.value === expiration);
      const expiresAt = expirationOption?.ms
        ? new Date(Date.now() + expirationOption.ms)
        : undefined;

      const result = await uploadToMuxMd(
        content,
        {
          name: "message.md",
          type: "text/markdown",
          size: new TextEncoder().encode(content).length,
          model,
          thinking,
        },
        { expiresAt }
      );
      setUploadResult(result);

      // Cache the shared URL for future reference
      setSharedUrl(content, result.url);
    } catch (err) {
      console.error("Share failed:", err);
      setError(err instanceof Error ? err.message : "Failed to upload");
    } finally {
      setIsUploading(false);
    }
  };

  // The URL to display - either from cache or from new upload
  const displayUrl = uploadResult?.url ?? cachedUrl;

  const handleCopy = () => {
    if (displayUrl) {
      void copyToClipboard(displayUrl);
    }
  };

  const handleOpenInBrowser = () => {
    if (displayUrl) {
      window.open(displayUrl, "_blank", "noopener,noreferrer");
    }
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open) {
      // Reset state when closing
      setTimeout(() => {
        setUploadResult(null);
        setError(null);
        setExpiration("7d");
      }, 150);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={isAlreadyShared ? "Already shared" : "Share"}
          className={`flex h-6 w-6 items-center justify-center [&_svg]:size-3.5 ${
            isAlreadyShared ? "text-blue-400" : "text-placeholder"
          }`}
        >
          <Link2 />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-3">
        {!displayUrl ? (
          // Pre-upload: show expiration selector and share button
          <div className="space-y-3">
            <div className="text-foreground text-xs font-medium">Share Message</div>

            <div className="space-y-1.5">
              <label className="text-muted text-[10px] tracking-wider uppercase">Expires</label>
              <Select value={expiration} onValueChange={(v) => setExpiration(v as ExpirationValue)}>
                <SelectTrigger className="h-7 text-xs">
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
          // Post-upload or cached: show URL and copy button
          <div className="space-y-3">
            <div className="text-foreground text-xs font-medium">
              {cachedUrl && !uploadResult ? "Previously Shared" : "Link Created"}
            </div>

            <div className="border-border bg-background rounded border p-2">
              <code
                className="text-foreground block font-mono text-[10px] break-all"
                data-testid="share-url"
              >
                {displayUrl}
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

            {uploadResult?.expiresAt && (
              <p className="text-muted text-center text-[10px]">
                Expires {new Date(uploadResult.expiresAt).toLocaleDateString()}
              </p>
            )}

            {cachedUrl && !uploadResult && (
              <p className="text-muted text-center text-[10px]">
                Link may have expired.{" "}
                <button
                  onClick={() => void handleShare()}
                  className="text-blue-400 hover:underline"
                  disabled={isUploading}
                >
                  Create new link
                </button>
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};
