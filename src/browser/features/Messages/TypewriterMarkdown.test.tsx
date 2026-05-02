import type { UseSmoothStreamingTextOptions } from "@/browser/hooks/useSmoothStreamingText";
import { useSmoothStreamingText as importedUseSmoothStreamingText } from "@/browser/hooks/useSmoothStreamingText";
import { useWorkspaceStreamingStats as importedUseWorkspaceStreamingStats } from "@/browser/stores/WorkspaceStore";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { MarkdownCore as ImportedMarkdownCore } from "./MarkdownCore";
import { TypewriterMarkdown } from "./TypewriterMarkdown";

const actualMarkdownCore = ImportedMarkdownCore;
const actualUseSmoothStreamingText = importedUseSmoothStreamingText;
const actualUseWorkspaceStreamingStats = importedUseWorkspaceStreamingStats;

const mockUseSmoothStreamingText = mock(
  (options: UseSmoothStreamingTextOptions): { visibleText: string; isCaughtUp: boolean } => ({
    visibleText: options.fullText,
    isCaughtUp: !options.isStreaming,
  })
);

const mockUseWorkspaceStreamingStats = mock((_workspaceId: string) => null);

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
  await mock.module("@/browser/stores/WorkspaceStore", () => ({
    useWorkspaceStreamingStats: mockUseWorkspaceStreamingStats,
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
  await mock.module("@/browser/stores/WorkspaceStore", () => ({
    useWorkspaceStreamingStats: actualUseWorkspaceStreamingStats,
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
    mockUseWorkspaceStreamingStats.mockClear();
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
        content="Hello world"
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
      liveCharsPerSec: 0,
    });
  });

  test("bypasses smoothing for replay streams", () => {
    render(
      <TypewriterMarkdown
        content="Replayed content"
        isComplete={false}
        streamKey="msg-2"
        streamSource="replay"
      />
    );

    expect(mockUseSmoothStreamingText).toHaveBeenCalledWith(
      expect.objectContaining({ bypassSmoothing: true })
    );
  });

  // Regression: completed historical messages must not subscribe to live
  // streaming stats for their workspace, otherwise every assistant message in a
  // long transcript re-renders on every stream-delta of an active stream and
  // re-introduces the cascade jitter this PR is supposed to eliminate.
  test("completed messages subscribe with empty key (no live-stats updates)", () => {
    render(
      <TypewriterMarkdown
        content="Historical reply"
        isComplete={true}
        streamKey="msg-old"
        streamSource="live"
        workspaceId="ws-active"
      />
    );

    // Hook still runs (rules of hooks), but the key must be the no-op sentinel.
    expect(mockUseWorkspaceStreamingStats).toHaveBeenCalledWith("");
    expect(mockUseWorkspaceStreamingStats).not.toHaveBeenCalledWith("ws-active");
  });

  test("streaming messages subscribe with the real workspace key", () => {
    render(
      <TypewriterMarkdown
        content="Streaming reply"
        isComplete={false}
        streamKey="msg-live"
        streamSource="live"
        workspaceId="ws-active"
      />
    );

    expect(mockUseWorkspaceStreamingStats).toHaveBeenCalledWith("ws-active");
  });

  // The data-streaming attribute is the gate for the per-block fade-in CSS rule
  // (see globals.css, .markdown-content[data-streaming="true"] .streamdown-root > *).
  // It must only be present on the wrapper while the message is actively streaming
  // — otherwise historical/replayed transcripts would re-trigger the animation
  // every time their content prop changes.
  test("sets data-streaming on the wrapper only while streaming", () => {
    const streaming = render(
      <TypewriterMarkdown content="Live" isComplete={false} streamKey="msg-anim-live" />
    );
    expect(
      streaming.container.querySelector(".markdown-content")?.getAttribute("data-streaming")
    ).toBe("true");
    streaming.unmount();

    const completed = render(
      <TypewriterMarkdown content="Done" isComplete={true} streamKey="msg-anim-done" />
    );
    // Absent (not "false") on completed messages so the CSS selector
    // [data-streaming="true"] cannot match.
    expect(
      completed.container.querySelector(".markdown-content")?.getAttribute("data-streaming")
    ).toBeNull();
  });
});
