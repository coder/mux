import React, { useState } from "react";
import { CopyIcon } from "@/browser/components/icons/CopyIcon";
import { copyToClipboard } from "@/browser/utils/clipboard";

interface CopyButtonProps {
  /**
   * The text to copy to clipboard
   */
  text: string;
  /**
   * Additional CSS class for styling
   */
  className?: string;
  /**
   * Duration in ms to show "Copied!" feedback (default: 2000)
   */
  feedbackDuration?: number;
}

/**
 * Reusable copy button with clipboard functionality and visual feedback
 */
export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  className = "",
  feedbackDuration = 2000,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void (async () => {
      try {
        await copyToClipboard(text);
        setCopied(true);
        setTimeout(() => setCopied(false), feedbackDuration);
      } catch (error) {
        console.warn("Failed to copy to clipboard:", error);
      }
    })();
  };

  return (
    <button
      className={`copy-button ${className}`}
      onClick={handleCopy}
      aria-label="Copy to clipboard"
    >
      {copied ? <span className="copy-feedback">Copied!</span> : <CopyIcon className="copy-icon" />}
    </button>
  );
};
