import type { ReactNode } from "react";
import { Box, Text } from "ink";
import MarkdownIt from "markdown-it";
import { CodeBlock } from "@/cli/tui/components/CodeBlock";

interface MarkdownTextProps {
  content: string;
  color?: string;
}

interface MarkdownToken {
  type: string;
  tag: string;
  attrs: Array<[string, string]> | null;
  content: string;
  info: string;
  children: MarkdownToken[] | null;
}

const md = new MarkdownIt({ html: false, breaks: true, linkify: false });

function findClosingIndex(tokens: MarkdownToken[], startIndex: number): number {
  const openingToken = tokens[startIndex];
  if (!openingToken?.type.endsWith("_open")) {
    return -1;
  }

  const closingType = openingToken.type.replace(/_open$/, "_close");
  let depth = 0;

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === openingToken.type) {
      depth += 1;
      continue;
    }

    if (token.type === closingType) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function tokenText(token: MarkdownToken): string {
  if (token.content.length > 0) {
    return token.content;
  }

  if (token.children) {
    return token.children.map((child) => tokenText(child)).join("");
  }

  return "";
}

function findLinkHref(token: MarkdownToken): string | null {
  if (!token.attrs) {
    return null;
  }

  for (const [name, value] of token.attrs) {
    if (name === "href") {
      return value;
    }
  }

  return null;
}

function renderInlineTokens(
  tokens: MarkdownToken[],
  keyPrefix: string,
  baseColor?: string
): ReactNode[] {
  const elements: ReactNode[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const key = `${keyPrefix}-inline-${index}`;

    switch (token.type) {
      case "text":
        elements.push(token.content);
        break;
      case "softbreak":
      case "hardbreak":
        elements.push("\n");
        break;
      case "code_inline":
        elements.push(
          <Text color="yellow" key={key}>
            {token.content}
          </Text>
        );
        break;
      case "strong_open":
      case "em_open":
      case "link_open": {
        const closeIndex = findClosingIndex(tokens, index);
        if (closeIndex === -1) {
          elements.push(token.content);
          break;
        }

        const childTokens = tokens.slice(index + 1, closeIndex);
        const childElements = renderInlineTokens(childTokens, `${key}-children`, baseColor);

        if (token.type === "strong_open") {
          elements.push(
            <Text key={key} bold color={baseColor}>
              {childElements}
            </Text>
          );
        } else if (token.type === "em_open") {
          elements.push(
            <Text key={key} dimColor color={baseColor}>
              {childElements}
            </Text>
          );
        } else {
          const href = findLinkHref(token);
          elements.push(
            <Text key={key} color={baseColor}>
              {childElements}
              {href ? ` (${href})` : ""}
            </Text>
          );
        }

        index = closeIndex;
        break;
      }
      default:
        elements.push(tokenText(token));
        break;
    }
  }

  return elements;
}

function renderInlineToken(
  token: MarkdownToken,
  keyPrefix: string,
  baseColor?: string
): ReactNode[] {
  if (!token.children || token.children.length === 0) {
    return token.content.length > 0 ? [token.content] : [];
  }

  return renderInlineTokens(token.children, keyPrefix, baseColor);
}

function renderListItem(
  tokenSlice: MarkdownToken[],
  keyPrefix: string,
  baseColor?: string
): ReactNode {
  const inlineToken = tokenSlice.find((token) => token.type === "inline");
  const inlineElements = inlineToken
    ? renderInlineToken(inlineToken, `${keyPrefix}-list-item`, baseColor)
    : tokenSlice
        .map((token) => tokenText(token))
        .join(" ")
        .trim();

  return (
    <Text key={`${keyPrefix}-list-item-text`} color={baseColor}>
      {"  • "}
      {inlineElements}
    </Text>
  );
}

function renderBlockTokens(
  tokens: MarkdownToken[],
  keyPrefix: string,
  baseColor?: string
): ReactNode[] {
  const elements: ReactNode[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const key = `${keyPrefix}-block-${index}`;

    if (token.type === "fence" || token.type === "code_block") {
      elements.push(<CodeBlock key={key} language={token.info} code={token.content} />);
      continue;
    }

    if (token.type === "heading_open" || token.type === "paragraph_open") {
      const closeIndex = findClosingIndex(tokens, index);
      if (closeIndex === -1) {
        elements.push(
          <Text color={baseColor} key={key}>
            {tokenText(token)}
          </Text>
        );
        continue;
      }

      const innerTokens = tokens.slice(index + 1, closeIndex);
      const inlineToken = innerTokens.find((innerToken) => innerToken.type === "inline");
      const inlineChildren = inlineToken
        ? renderInlineToken(inlineToken, `${key}-inline`, baseColor)
        : innerTokens.map((innerToken) => tokenText(innerToken)).join("");

      elements.push(
        <Box key={key} marginBottom={1}>
          <Text bold={token.type === "heading_open"} color={baseColor}>
            {inlineChildren}
          </Text>
        </Box>
      );

      index = closeIndex;
      continue;
    }

    if (token.type === "bullet_list_open") {
      const closeIndex = findClosingIndex(tokens, index);
      if (closeIndex === -1) {
        continue;
      }

      const listElements: ReactNode[] = [];
      const listTokens = tokens.slice(index + 1, closeIndex);
      for (let listIndex = 0; listIndex < listTokens.length; listIndex += 1) {
        const listToken = listTokens[listIndex];
        if (listToken.type !== "list_item_open") {
          continue;
        }

        const itemCloseIndex = findClosingIndex(listTokens, listIndex);
        if (itemCloseIndex === -1) {
          continue;
        }

        const itemTokens = listTokens.slice(listIndex + 1, itemCloseIndex);
        listElements.push(renderListItem(itemTokens, `${key}-item-${listIndex}`, baseColor));
        listIndex = itemCloseIndex;
      }

      elements.push(
        <Box key={key} marginBottom={1} flexDirection="column">
          {listElements}
        </Box>
      );

      index = closeIndex;
      continue;
    }

    if (token.type === "inline") {
      elements.push(
        <Text key={key} color={baseColor}>
          {renderInlineToken(token, `${key}-inline`, baseColor)}
        </Text>
      );
      continue;
    }

    if (token.type === "text" || token.content.length > 0) {
      elements.push(
        <Text key={key} color={baseColor}>
          {token.content}
        </Text>
      );
    }
  }

  return elements;
}

export function MarkdownText(props: MarkdownTextProps) {
  if (!props.content) {
    return null;
  }

  try {
    // Keep TUI rendering lightweight while still honoring the markdown structure users expect.
    const tokens = md.parse(props.content, {}) as MarkdownToken[];
    const elements = renderBlockTokens(tokens, "markdown", props.color);

    if (elements.length === 0) {
      return <Text color={props.color}>{props.content}</Text>;
    }

    return <Box flexDirection="column">{elements}</Box>;
  } catch {
    return <Text color={props.color}>{props.content}</Text>;
  }
}
