import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { findTranscriptTextMatches, focusTranscriptTextMatch } from "./transcriptSearch";

function createTranscriptRoot(markup: string): HTMLElement {
  const transcriptRoot = document.createElement("div");
  transcriptRoot.innerHTML = markup;
  document.body.appendChild(transcriptRoot);
  return transcriptRoot;
}

describe("transcriptSearch", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("finds case-insensitive matches inside transcript messages only", () => {
    const transcriptRoot = createTranscriptRoot(`
      <div data-message-content>
        <p>Alpha beta gamma</p>
      </div>
      <p>beta outside transcript message</p>
      <div data-message-content>
        <p>Second BETA match</p>
      </div>
    `);

    const matches = findTranscriptTextMatches({ transcriptRoot, query: "beta" });

    expect(matches).toHaveLength(2);
    expect(
      matches.map((match) => match.textNode.nodeValue?.slice(match.startOffset, match.endOffset))
    ).toEqual(["beta", "BETA"]);
  });

  test("finds repeated matches within a single text node", () => {
    const transcriptRoot = createTranscriptRoot(`
      <div data-message-content>
        <p>echo echo echo</p>
      </div>
    `);

    const matches = findTranscriptTextMatches({ transcriptRoot, query: "echo" });

    expect(matches).toHaveLength(3);
  });

  test("ignores text inside interactive elements", () => {
    const transcriptRoot = createTranscriptRoot(`
      <div data-message-content>
        <button>secret shortcut</button>
        <p>visible shortcut</p>
      </div>
    `);

    const matches = findTranscriptTextMatches({ transcriptRoot, query: "shortcut" });

    expect(matches).toHaveLength(1);
    expect(matches[0].textNode.nodeValue?.slice(matches[0].startOffset, matches[0].endOffset)).toBe(
      "shortcut"
    );
  });

  test("focuses a match by selecting text and scrolling its message", () => {
    const transcriptRoot = createTranscriptRoot(`
      <div data-message-id="history-1">
        <div data-message-content>
          <p id="message-text">Find this text</p>
        </div>
      </div>
    `);

    const messageRow = transcriptRoot.querySelector<HTMLElement>("[data-message-id='history-1']");
    if (!messageRow) {
      throw new Error("Expected message row");
    }

    let scrolled = false;
    messageRow.scrollIntoView = () => {
      scrolled = true;
    };

    const matches = findTranscriptTextMatches({ transcriptRoot, query: "this" });
    expect(matches).toHaveLength(1);

    const didFocus = focusTranscriptTextMatch(matches[0]);
    expect(didFocus).toBe(true);
    expect(window.getSelection()?.toString()).toBe("this");
    expect(scrolled).toBe(true);
  });
});
