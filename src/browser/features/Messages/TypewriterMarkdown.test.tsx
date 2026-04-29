import type { UseSmoothStreamingTextOptions } from "@/browser/hooks/useSmoothStreamingText";
import { useSmoothStreamingText as importedUseSmoothStreamingText } from "@/browser/hooks/useSmoothStreamingText";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { MarkdownCore as ImportedMarkdownCore } from "./MarkdownCore";
import { TypewriterMarkdown } from "./TypewriterMarkdown";

const actualMarkdownCore = ImportedMarkdownCore;
const actualUseSmoothStreamingText = importedUseSmoothStreamingText;

const mockUseSmoothStreamingText = mock(
  (options: UseSmoothStreamingTextOptions): { visibleText: string; isCaughtUp: boolean } => ({
    visibleText: options.fullText,
    isCaughtUp: !options.isStreaming,
  })
);

function MarkdownCoreStub(props: { content: string }) {
  return <div data-testid="markdown-core">{props.content}</div>;
}

// Keep module mocks inside test hooks: Bun loads test files before afterAll runs, so
// file-scope mock.module() calls can pollute unrelated files during collection.
async function installTypewriterMarkdownModuleMocks() {
  await mock.module("./MarkdownCore", () => ({
    MarkdownCore: MarkdownCoreStub,
  }));
  await mock.module("@/browser/hooks/useSmoothStreamingText", () => ({
    useSmoothStreamingText: mockUseSmoothStreamingText,
  }));
}

async function restoreTypewriterMarkdownModuleMocks() {
  // Bun 1.3.6's mock.module() has no disposer, and mock.restore() does not undo
  // module mocks. Restore the real exports so these stubs do not leak into later files.
  await mock.module("./MarkdownCore", () => ({
    MarkdownCore: actualMarkdownCore,
  }));
  await mock.module("@/browser/hooks/useSmoothStreamingText", () => ({
    useSmoothStreamingText: actualUseSmoothStreamingText,
  }));
}

describe("TypewriterMarkdown", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  afterAll(async () => {
    await restoreTypewriterMarkdownModuleMocks();
  });

  beforeEach(async () => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    await installTypewriterMarkdownModuleMocks();
    mockUseSmoothStreamingText.mockClear();
  });

  afterEach(async () => {
    cleanup();
    await restoreTypewriterMarkdownModuleMocks();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
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
