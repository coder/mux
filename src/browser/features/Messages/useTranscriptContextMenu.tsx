import React, { useCallback, useRef, useState } from "react";
import { Clipboard, Link as LinkIcon, TextQuote } from "lucide-react";
import { useContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { copyToClipboard } from "@/browser/utils/clipboard";
import {
  formatTranscriptTextAsQuote,
  getTranscriptContextMenuLink,
  getTranscriptContextMenuText,
} from "@/browser/utils/messages/transcriptContextMenu";
import {
  PositionedMenu,
  PositionedMenuItem,
} from "@/browser/components/PositionedMenu/PositionedMenu";

// Discriminated mode so the menu renders link vs text actions based on what
// the user right-clicked, without redundant conditional rendering paths.
type TranscriptContextMenuMode = { kind: "link" } | { kind: "text" };

interface UseTranscriptContextMenuOptions {
  transcriptRootRef: React.RefObject<HTMLElement | null>;
  onQuoteText: (quotedText: string) => void;
  onCopyText?: (text: string) => Promise<void>;
  hasInputTarget?: boolean;
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
  const transcriptMenuLinkRef = useRef<string>("");
  // Mode drives which menu items render; use state so the menu re-renders
  // to reflect link vs text actions when it opens.
  const [mode, setMode] = useState<TranscriptContextMenuMode | null>(null);
  const hasInputTarget = options.hasInputTarget ?? true;

  const handleTranscriptContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const transcriptRoot = options.transcriptRootRef.current;
      if (!transcriptRoot) {
        return;
      }

      // Links get priority: right-clicking an anchor should offer "Copy link"
      // rather than falling through to text quote/copy actions. Electron has
      // no native link context menu, so without this the action is unavailable.
      const link = getTranscriptContextMenuLink({
        transcriptRoot,
        target: event.target,
      });
      if (link) {
        transcriptMenuLinkRef.current = link;
        transcriptMenuTextRef.current = "";
        setMode({ kind: "link" });
        transcriptMenu.onContextMenu(event);
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
      transcriptMenuLinkRef.current = "";
      setMode({ kind: "text" });
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

  const handleCopyLink = useCallback(() => {
    const copyText = options.onCopyText ?? copyToClipboard;
    void copyText(transcriptMenuLinkRef.current);
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
        {mode?.kind === "link" ? (
          <PositionedMenuItem icon={<LinkIcon />} label="Copy link" onClick={handleCopyLink} />
        ) : (
          <>
            {hasInputTarget ? (
              <PositionedMenuItem
                icon={<TextQuote />}
                label="Quote in input"
                onClick={handleQuoteText}
              />
            ) : null}
            <PositionedMenuItem icon={<Clipboard />} label="Copy text" onClick={handleCopyText} />
          </>
        )}
      </PositionedMenu>
    ),
  };
}
