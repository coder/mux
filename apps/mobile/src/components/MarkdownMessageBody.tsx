import type { JSX } from "react";
import { useMemo } from "react";
import Markdown from "react-native-markdown-display";
import { useTheme } from "../theme";
import { assert } from "../utils/assert";
import {
  createMarkdownStyles,
  type MarkdownVariant,
  type MarkdownStyle,
} from "../messages/markdownStyles";
import { normalizeMarkdown } from "../messages/markdownUtils";

export interface MarkdownMessageBodyProps {
  content: string | null | undefined;
  variant: MarkdownVariant;
  styleOverrides?: Partial<MarkdownStyle>;
}

export function MarkdownMessageBody({
  content,
  variant,
  styleOverrides,
}: MarkdownMessageBodyProps): JSX.Element | null {
  assert(
    content === undefined || content === null || typeof content === "string",
    "MarkdownMessageBody expects string content"
  );

  const theme = useTheme();

  const normalizedContent = useMemo(() => {
    if (typeof content !== "string") {
      return "";
    }

    return normalizeMarkdown(content);
  }, [content]);

  const trimmed = normalizedContent.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const markdownStyles = useMemo(() => {
    const base = createMarkdownStyles(theme, variant);
    if (!styleOverrides) {
      return base;
    }

    return {
      ...base,
      ...styleOverrides,
    } as MarkdownStyle;
  }, [theme, variant, styleOverrides]);

  return <Markdown style={markdownStyles}>{normalizedContent}</Markdown>;
}
