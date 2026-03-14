import React, { useCallback, useRef } from "react";
import { Clipboard, TextQuote } from "lucide-react";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { copyToClipboard } from "@/browser/utils/clipboard";
import {
  formatTranscriptTextAsQuote,
  getTranscriptContextMenuText,
} from "@/browser/utils/messages/transcriptContextMenu";
import {
  PositionedMenu,
  PositionedMenuItem,
} from "@/browser/components/PositionedMenu/PositionedMenu";

interface UseTranscriptContextMenuOptions {
  transcriptRootRef: React.RefObject<HTMLElement | null>;
  onQuoteText: (quotedText: string) => void;
  onCopyText?: (text: string) => Promise<void>;
}

interface UseTranscriptContextMenuReturn {
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  menu: React.ReactNode;
}

export function useTranscriptContextMenu(
  options: UseTranscriptContextMenuOptions
): UseTranscriptContextMenuReturn {
  const transcriptMenu = useContextMenuPosition();
  const transcriptMenuTextRef = useRef<string>("");

  const handleTranscriptContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const transcriptRoot = options.transcriptRootRef.current;
      if (!transcriptRoot) {
        return;
      }

      const selection = typeof window === "undefined" ? null : window.getSelection();
      const text = getTranscriptContextMenuText({
        transcriptRoot,
        target: event.target,
        selection,
      });

      if (!text) {
        transcriptMenu.close();
        return;
      }

      transcriptMenuTextRef.current = text;
      transcriptMenu.onContextMenu(event);
    },
    [options.transcriptRootRef, transcriptMenu]
  );

  const handleQuoteText = useCallback(() => {
    const quotedText = formatTranscriptTextAsQuote(transcriptMenuTextRef.current);
    transcriptMenu.close();
    if (!quotedText) {
      return;
    }

    options.onQuoteText(quotedText);
  }, [options, transcriptMenu]);

  const handleCopyText = useCallback(() => {
    const copyText = options.onCopyText ?? copyToClipboard;
    void copyText(transcriptMenuTextRef.current);
    transcriptMenu.close();
  }, [options, transcriptMenu]);

  return {
    onContextMenu: handleTranscriptContextMenu,
    menu: (
      <PositionedMenu
        open={transcriptMenu.isOpen}
        onOpenChange={transcriptMenu.onOpenChange}
        position={transcriptMenu.position}
      >
        <PositionedMenuItem icon={<TextQuote />} label="Quote in input" onClick={handleQuoteText} />
        <PositionedMenuItem icon={<Clipboard />} label="Copy text" onClick={handleCopyText} />
      </PositionedMenu>
    ),
  };
}
