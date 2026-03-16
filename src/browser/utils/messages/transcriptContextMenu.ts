import {
  TRANSCRIPT_IGNORE_CONTEXT_MENU_SELECTOR,
  TRANSCRIPT_MESSAGE_SELECTOR,
  TRANSCRIPT_QUOTE_ROOT_SELECTOR,
  TRANSCRIPT_QUOTE_TEXT_ATTRIBUTE,
} from "./transcriptQuoteAttributes";

// Preserve native link context-menu actions (open/copy link, etc.) by treating
// anchors and explicitly opted-out transcript chrome as interactive targets.
const INTERACTIVE_SELECTOR = `button, [role='button'], input, textarea, select, a[href], ${TRANSCRIPT_IGNORE_CONTEXT_MENU_SELECTOR}`;
const QUOTEABLE_BLOCK_SELECTOR = [
  ".code-block-wrapper",
  ".mermaid-container",
  "p",
  "li",
  "blockquote",
  "pre",
  "code",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "summary",
].join(", ");

function normalizeTranscriptText(rawText: string): string {
  return rawText.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

function hasNonWhitespaceTranscriptText(text: string): boolean {
  return text.trim().length > 0;
}

function getEventTargetElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object") {
    return null;
  }

  const nodeTarget = target as { nodeType?: number; parentElement?: Element | null };
  if (nodeTarget.nodeType === 1) {
    return target as Element;
  }

  if (nodeTarget.nodeType === 3) {
    return nodeTarget.parentElement ?? null;
  }

  return null;
}

function getClosestTranscriptAncestor(
  transcriptRoot: HTMLElement,
  element: Element | null,
  selector: string
): Element | null {
  if (!element || !transcriptRoot.contains(element)) {
    return null;
  }

  const ancestor = element.closest(selector);
  return ancestor && transcriptRoot.contains(ancestor) ? ancestor : null;
}

function getTranscriptQuoteOverride(element: Element | null): string | null {
  if (!element) {
    return null;
  }

  const override = element.getAttribute(TRANSCRIPT_QUOTE_TEXT_ATTRIBUTE);
  if (override == null) {
    return null;
  }

  const normalizedOverride = normalizeTranscriptText(override);
  return hasNonWhitespaceTranscriptText(normalizedOverride) ? normalizedOverride : null;
}

function getTranscriptQuoteableText(element: Element | null): string | null {
  if (!element) {
    return null;
  }

  const override = getTranscriptQuoteOverride(element);
  if (override) {
    return override;
  }

  const normalizedText = normalizeTranscriptText(element.textContent ?? "");
  return hasNonWhitespaceTranscriptText(normalizedText) ? normalizedText : null;
}

function getClosestTranscriptQuoteBlock(
  quoteRoot: Element,
  targetElement: Element
): Element | null {
  const quoteBlock = targetElement.closest(QUOTEABLE_BLOCK_SELECTOR);
  return quoteBlock && quoteRoot.contains(quoteBlock) ? quoteBlock : null;
}

function selectionIntersectsIgnoredChrome(quoteRoot: Element, selectionRange: Range): boolean {
  for (const ignoredElement of quoteRoot.querySelectorAll(
    TRANSCRIPT_IGNORE_CONTEXT_MENU_SELECTOR
  )) {
    if (selectionRange.intersectsNode(ignoredElement)) {
      return true;
    }
  }

  return false;
}

function getSelectedTranscriptText(
  transcriptRoot: HTMLElement,
  selection: Selection | null,
  target: EventTarget | null
): string | null {
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const selectedText = normalizeTranscriptText(selection.toString());
  if (!hasNonWhitespaceTranscriptText(selectedText)) {
    return null;
  }

  const selectedRange = selection.getRangeAt(0);
  const startElement = getEventTargetElement(selectedRange.startContainer);
  const endElement = getEventTargetElement(selectedRange.endContainer);
  const targetElement = getEventTargetElement(target);

  const startMessage = getClosestTranscriptAncestor(
    transcriptRoot,
    startElement,
    TRANSCRIPT_MESSAGE_SELECTOR
  );
  const endMessage = getClosestTranscriptAncestor(
    transcriptRoot,
    endElement,
    TRANSCRIPT_MESSAGE_SELECTOR
  );
  const startQuoteRoot = getClosestTranscriptAncestor(
    transcriptRoot,
    startElement,
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  );
  const endQuoteRoot = getClosestTranscriptAncestor(
    transcriptRoot,
    endElement,
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  );

  // Require the full selection range to stay within a single quoteable transcript body
  // so we do not accidentally quote text from non-message interstitial UI.
  if (
    startMessage === null ||
    endMessage === null ||
    startMessage !== endMessage ||
    startQuoteRoot === null ||
    endQuoteRoot === null ||
    startQuoteRoot !== endQuoteRoot
  ) {
    return null;
  }

  const targetMessage = getClosestTranscriptAncestor(
    transcriptRoot,
    targetElement,
    TRANSCRIPT_MESSAGE_SELECTOR
  );
  const targetQuoteRoot = getClosestTranscriptAncestor(
    transcriptRoot,
    targetElement,
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  );

  if (
    targetMessage !== null &&
    targetQuoteRoot !== null &&
    (targetMessage !== startMessage || targetQuoteRoot !== startQuoteRoot)
  ) {
    return null;
  }

  if (selectionIntersectsIgnoredChrome(startQuoteRoot, selectedRange)) {
    return null;
  }

  return selectedText;
}

function getHoveredTranscriptText(
  transcriptRoot: HTMLElement,
  target: EventTarget | null
): string | null {
  const targetElement = getEventTargetElement(target);
  if (!targetElement || !transcriptRoot.contains(targetElement)) {
    return null;
  }

  if (targetElement.closest(INTERACTIVE_SELECTOR)) {
    return null;
  }

  const quoteRoot = getClosestTranscriptAncestor(
    transcriptRoot,
    targetElement,
    TRANSCRIPT_QUOTE_ROOT_SELECTOR
  );
  if (!quoteRoot) {
    return null;
  }

  const quoteBlock = getClosestTranscriptQuoteBlock(quoteRoot, targetElement);
  if (quoteBlock) {
    return getTranscriptQuoteableText(quoteBlock);
  }

  // Quote roots act as selection boundaries. Fall back to an explicit root-level text override
  // for custom renderers whose DOM does not expose stable semantic blocks, but avoid quoting the
  // entire message when the user right-clicks the root container's empty padding.
  if (targetElement !== quoteRoot) {
    const quoteRootOverride = getTranscriptQuoteOverride(quoteRoot);
    if (quoteRootOverride) {
      return quoteRootOverride;
    }

    return getTranscriptQuoteableText(targetElement);
  }

  return null;
}

export interface TranscriptContextMenuTextOptions {
  transcriptRoot: HTMLElement;
  target: EventTarget | null;
  selection: Selection | null;
}

/**
 * Resolve transcript text for right-click actions.
 *
 * Priority:
 * 1) Current selection inside the same quoteable transcript body
 * 2) The nearest explicitly marked quote block under the cursor
 * 3) A root-level raw-text override for custom renderers whose DOM is not a faithful text source
 */
export function getTranscriptContextMenuText(
  options: TranscriptContextMenuTextOptions
): string | null {
  // Interactive transcript targets should keep native browser context-menu actions
  // (e.g. open/copy link) even when a transcript selection currently exists.
  const targetElement = getEventTargetElement(options.target);
  if (
    targetElement &&
    options.transcriptRoot.contains(targetElement) &&
    targetElement.closest(INTERACTIVE_SELECTOR)
  ) {
    return null;
  }

  const selectedText = getSelectedTranscriptText(
    options.transcriptRoot,
    options.selection,
    options.target
  );
  if (selectedText) {
    return selectedText;
  }

  return getHoveredTranscriptText(options.transcriptRoot, options.target);
}

/**
 * Convert plain transcript text into Markdown blockquote syntax so pasted context
 * is visually separated from the user's next prompt.
 */
export function formatTranscriptTextAsQuote(text: string): string {
  const normalizedText = normalizeTranscriptText(text);
  if (!hasNonWhitespaceTranscriptText(normalizedText)) {
    return "";
  }

  const quotedLines = normalizedText
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"));

  return `${quotedLines.join("\n")}\n\n`;
}
