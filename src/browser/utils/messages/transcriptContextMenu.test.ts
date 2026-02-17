import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { formatTranscriptTextAsQuote, getTranscriptContextMenuText } from "./transcriptContextMenu";

function createTranscriptRoot(markup: string): HTMLElement {
  const transcriptRoot = document.createElement("div");
  transcriptRoot.innerHTML = markup;
  document.body.appendChild(transcriptRoot);
  return transcriptRoot;
}

function getFirstTextNode(element: Element | null): Text {
  const firstChild = element?.firstChild;
  if (firstChild?.nodeType !== 3) {
    throw new Error("Expected element to contain a text node");
  }

  return firstChild as Text;
}

describe("transcriptContextMenu", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("prefers selected transcript text over hovered text", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div data-message-content><p id="message">Alpha beta gamma</p></div>`
    );
    const paragraph = transcriptRoot.querySelector("#message");
    expect(paragraph).not.toBeNull();

    const textNode = getFirstTextNode(paragraph);

    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 10);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("beta");
  });

  test("preserves leading and trailing whitespace in selected transcript text", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div data-message-content><p id="message">  keep this whitespace  </p></div>`
    );
    const paragraph = transcriptRoot.querySelector("#message");
    expect(paragraph).not.toBeNull();

    const textNode = getFirstTextNode(paragraph);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, "  keep this whitespace  ".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("  keep this whitespace  ");
  });

  test("returns null for interactive targets even when transcript selection exists", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div data-message-content><p id="message">Alpha beta gamma</p><a id="message-link" href="https://example.com">Example</a></div>`
    );
    const paragraph = transcriptRoot.querySelector("#message");
    const link = transcriptRoot.querySelector("#message-link");
    expect(paragraph).not.toBeNull();
    expect(link).not.toBeNull();

    const textNode = getFirstTextNode(paragraph);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: link,
      selection,
    });

    expect(result).toBeNull();
  });

  test("falls back to hovered transcript text when selection is outside transcript", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div data-message-content><p id="message">Hovered transcript text</p></div>`
    );
    const paragraph = transcriptRoot.querySelector("#message");
    expect(paragraph).not.toBeNull();

    const outsideParagraph = document.createElement("p");
    outsideParagraph.textContent = "Outside selection";
    document.body.appendChild(outsideParagraph);

    const outsideTextNode = getFirstTextNode(outsideParagraph);

    const range = document.createRange();
    range.setStart(outsideTextNode, 0);
    range.setEnd(outsideTextNode, "Outside".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("Hovered transcript text");
  });

  test("falls back to hovered text when selection is inside transcript root but outside message content", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div id="notice">System notice text</div><div data-message-content><p id="message">Hovered transcript text</p></div>`
    );
    const paragraph = transcriptRoot.querySelector("#message");
    const notice = transcriptRoot.querySelector("#notice");
    expect(paragraph).not.toBeNull();
    expect(notice).not.toBeNull();

    const noticeTextNode = getFirstTextNode(notice);

    const range = document.createRange();
    range.setStart(noticeTextNode, 0);
    range.setEnd(noticeTextNode, "System".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("Hovered transcript text");
  });

  test("falls back to hovered text when selection spans multiple message-content blocks", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div data-message-content><p id="message-a">First message</p></div><div id="notice">System notice text</div><div data-message-content><p id="message-b">Second message</p></div>`
    );
    const messageA = transcriptRoot.querySelector("#message-a");
    const messageB = transcriptRoot.querySelector("#message-b");
    expect(messageA).not.toBeNull();
    expect(messageB).not.toBeNull();

    const messageATextNode = getFirstTextNode(messageA);
    const messageBTextNode = getFirstTextNode(messageB);

    const range = document.createRange();
    range.setStart(messageATextNode, 0);
    range.setEnd(messageBTextNode, "Second".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: messageB,
      selection,
    });

    expect(result).toBe("Second message");
  });

  test("falls back to hovered transcript text when selection crosses transcript boundary", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div data-message-content><p id="message">Hovered transcript text</p></div>`
    );
    const paragraph = transcriptRoot.querySelector("#message");
    expect(paragraph).not.toBeNull();

    const outsideParagraph = document.createElement("p");
    outsideParagraph.textContent = "Outside selection";
    document.body.appendChild(outsideParagraph);

    const outsideTextNode = getFirstTextNode(outsideParagraph);
    const insideTextNode = getFirstTextNode(paragraph);

    const range = document.createRange();
    range.setStart(outsideTextNode, 0);
    range.setEnd(insideTextNode, "Hovered".length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target: paragraph,
      selection,
    });

    expect(result).toBe("Hovered transcript text");
  });

  test("returns null when target is outside message content", () => {
    const transcriptRoot = createTranscriptRoot(`<p id="outside-message">No message wrapper</p>`);
    const target = transcriptRoot.querySelector("#outside-message");
    expect(target).not.toBeNull();

    const result = getTranscriptContextMenuText({
      transcriptRoot,
      target,
      selection: null,
    });

    expect(result).toBeNull();
  });

  test("returns null for interactive elements including links", () => {
    const transcriptRoot = createTranscriptRoot(
      `<div data-message-content><button id="action">Open menu</button><a id="message-link" href="https://example.com">Example</a></div>`
    );
    const button = transcriptRoot.querySelector("#action");
    const link = transcriptRoot.querySelector("#message-link");
    expect(button).not.toBeNull();
    expect(link).not.toBeNull();

    const buttonResult = getTranscriptContextMenuText({
      transcriptRoot,
      target: button,
      selection: null,
    });
    const linkResult = getTranscriptContextMenuText({
      transcriptRoot,
      target: link,
      selection: null,
    });

    expect(buttonResult).toBeNull();
    expect(linkResult).toBeNull();
  });

  test("formats transcript text as markdown quote", () => {
    expect(formatTranscriptTextAsQuote("Line one\nLine two")).toBe("> Line one\n> Line two\n\n");
    expect(formatTranscriptTextAsQuote("  indented\nline\n")).toBe(">   indented\n> line\n>\n\n");
    expect(formatTranscriptTextAsQuote("\n\n")).toBe("");
  });
});
