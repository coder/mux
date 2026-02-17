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
    expect(formatTranscriptTextAsQuote("\n\n")).toBe("");
  });
});
