import React from "react";
import { AlertTriangle, Check, Lock, PenTool } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  HelpIndicator,
} from "@/browser/components/Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";
import type { SigningCapabilities } from "@/common/orpc/schemas";

/** Encryption info tooltip shown next to share headers */
export const EncryptionBadge = () => (
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
export interface SigningBadgeProps {
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

export const SigningBadge = ({
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
