import type { UseSmoothStreamingTextOptions } from "@/browser/hooks/useSmoothStreamingText";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

const mockUseSmoothStreamingText = mock(
  (options: UseSmoothStreamingTextOptions): { visibleText: string; isCaughtUp: boolean } => ({
    visibleText: options.fullText,
    isCaughtUp: !options.isStreaming,
  })
);

void mock.module("./MarkdownCore", () => ({
  MarkdownCore: (props: { content: string }) => (
    <div data-testid="markdown-core">{props.content}</div>
  ),
}));

void mock.module("@/browser/hooks/useSmoothStreamingText", () => ({
  useSmoothStreamingText: mockUseSmoothStreamingText,
}));

import { TypewriterMarkdown } from "./TypewriterMarkdown";

describe("TypewriterMarkdown", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    mockUseSmoothStreamingText.mockClear();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("passes smoothed visible text to MarkdownCore when streaming", () => {
    mockUseSmoothStreamingText.mockImplementationOnce(() => ({
      visibleText: "Hel",
      isCaughtUp: false,
    }));

    const view = render(
      <TypewriterMarkdown
        deltas={["Hello world"]}
        isComplete={false}
        streamKey="msg-1"
        streamSource="live"
      />
    );

    expect(view.getByTestId("markdown-core").textContent).toBe("Hel");
    expect(mockUseSmoothStreamingText).toHaveBeenCalledWith({
      fullText: "Hello world",
      isStreaming: true,
      bypassSmoothing: false,
      streamKey: "msg-1",
    });
  });

  test("bypasses smoothing for replay streams", () => {
    render(
      <TypewriterMarkdown
        deltas={["Replayed content"]}
        isComplete={false}
        streamKey="msg-2"
        streamSource="replay"
      />
    );

    expect(mockUseSmoothStreamingText).toHaveBeenCalledWith(
      expect.objectContaining({ bypassSmoothing: true })
    );
  });
});
