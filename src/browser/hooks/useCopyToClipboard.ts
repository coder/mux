import { useState, useCallback } from "react";
import { COPY_FEEDBACK_DURATION_MS } from "@/common/constants/ui";
import { copyToClipboard as copyToClipboardUtil } from "@/browser/utils/clipboard";

/**
 * Hook for copy-to-clipboard functionality with temporary "copied" feedback state.
 *
 * @param clipboardWriteText - Optional custom clipboard write function (defaults to copyToClipboard utility)
 * @returns Object with:
 *   - copied: boolean indicating if content was just copied (resets after COPY_FEEDBACK_DURATION_MS)
 *   - copyToClipboard: async function to copy text and trigger feedback
 */
export function useCopyToClipboard(
  clipboardWriteText: (text: string) => Promise<void> = copyToClipboardUtil
) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await clipboardWriteText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    },
    [clipboardWriteText]
  );

  return { copied, copyToClipboard };
}
