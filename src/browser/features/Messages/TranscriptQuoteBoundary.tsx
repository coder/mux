import React from "react";
import {
  getTranscriptQuoteRootProps,
  transcriptIgnoreContextMenuProps,
  transcriptMessageProps,
} from "@/browser/utils/messages/transcriptQuoteAttributes";

export const TranscriptMessageBoundary: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  children,
  ...props
}) => (
  <div {...transcriptMessageProps} {...props}>
    {children}
  </div>
);

interface TranscriptQuoteRootProps extends React.HTMLAttributes<HTMLDivElement> {
  text?: string | null;
}

export const TranscriptQuoteRoot: React.FC<TranscriptQuoteRootProps> = ({
  text,
  children,
  ...props
}) => (
  <div {...getTranscriptQuoteRootProps(text)} {...props}>
    {children}
  </div>
);

export const TranscriptIgnoreContextMenu: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  children,
  ...props
}) => (
  <div {...transcriptIgnoreContextMenuProps} {...props}>
    {children}
  </div>
);
