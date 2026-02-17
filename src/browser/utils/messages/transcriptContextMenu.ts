const TRANSCRIPT_TEXT_BLOCK_SELECTOR =
  "p, li, blockquote, pre, code, td, th, h1, h2, h3, h4, h5, h6";

const INTERACTIVE_SELECTOR = "button, [role='button'], input, textarea, select";

function normalizeTranscriptText(rawText: string): string {
  return rawText
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();
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

function getSelectedTranscriptText(
  transcriptRoot: HTMLElement,
  selection: Selection | null
): string | null {
  if (!selection) {
    return null;
  }

  const selectedText = normalizeTranscriptText(selection.toString());
  if (!selectedText) {
    return null;
  }

  const anchorInsideTranscript =
    selection.anchorNode !== null && transcriptRoot.contains(selection.anchorNode);
  const focusInsideTranscript =
    selection.focusNode !== null && transcriptRoot.contains(selection.focusNode);

  if (!anchorInsideTranscript && !focusInsideTranscript) {
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

  const messageContent = targetElement.closest("[data-message-content]");
  if (!messageContent || !transcriptRoot.contains(messageContent)) {
    return null;
  }

  const textContainer = targetElement.closest(TRANSCRIPT_TEXT_BLOCK_SELECTOR) ?? targetElement;
  const hoveredText = normalizeTranscriptText(textContainer.textContent ?? "");
  return hoveredText || null;
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
 * 1) Current selection inside the transcript (if any)
 * 2) Text content near the hovered element under the cursor
 */
export function getTranscriptContextMenuText(
  options: TranscriptContextMenuTextOptions
): string | null {
  const selectedText = getSelectedTranscriptText(options.transcriptRoot, options.selection);
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
  if (!normalizedText) {
    return "";
  }

  const quotedLines = normalizedText
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"));

  return `${quotedLines.join("\n")}\n\n`;
}
