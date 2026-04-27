import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { DisplayedMessage } from "@/common/types/message";
import type { UseSmoothStreamingTextOptions } from "@/browser/hooks/useSmoothStreamingText";

// Streaming reasoning uses TypewriterMarkdown → useSmoothStreamingText, which drives
// a RAF loop. happy-dom doesn't ship requestAnimationFrame, and we only care about
// the reasoning collapse/transition behavior here, so stub the smooth engine out.
void mock.module("@/browser/hooks/useSmoothStreamingText", () => ({
  useSmoothStreamingText: (options: UseSmoothStreamingTextOptions) => ({
    visibleText: options.fullText,
    isCaughtUp: !options.isStreaming,
  }),
}));

// Streamdown's async markdown pipeline is heavy and not what we're testing here —
// the layout-stability contract is independent of how the inner content is rendered.
// A stand-in MarkdownCore keeps the text queryable and render times bounded.
void mock.module("./MarkdownCore", () => ({
  MarkdownCore: (props: { content: string }) => (
    <div data-testid="markdown-core-stub">{props.content}</div>
  ),
}));

import { ReasoningMessage } from "./ReasoningMessage";

function createReasoningMessage(
  content: string,
  overrides?: Partial<DisplayedMessage & { type: "reasoning" }>
): DisplayedMessage & { type: "reasoning" } {
  return {
    type: "reasoning",
    id: "reasoning-1",
    historyId: "history-1",
    content,
    historySequence: 1,
    isStreaming: false,
    isPartial: false,
    isLastPartOfMessage: true,
    ...overrides,
  };
}

describe("ReasoningMessage", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("expands completed multi-line reasoning when header is clicked", () => {
    const message = createReasoningMessage("Summary line\nSecond line details");

    const { getByText, queryByText } = render(<ReasoningMessage message={message} />);

    // Collapsed reasoning should not render full markdown until expanded.
    expect(queryByText(/Second line details/)).toBeNull();

    fireEvent.click(getByText("Summary line"));

    expect(getByText(/Second line details/)).toBeDefined();
  });

  test("renders leading markdown-bold summary text as bold", () => {
    const message = createReasoningMessage("**Collecting context**\nSecond line details");

    const { container } = render(<ReasoningMessage message={message} />);

    const strongSummary = container.querySelector("strong");
    expect(strongSummary).not.toBeNull();
    expect(strongSummary?.textContent).toBe("Collecting context");
  });

  // The reasoning content container is the single <div> with these characteristic
  // font + opacity classes; the header icon's aria-hidden is on an SVG, so we
  // specifically target the text container.
  function getReasoningContentContainer(container: HTMLElement): HTMLDivElement | null {
    return (
      Array.from(container.querySelectorAll("div")).find((el) =>
        el.className.includes("italic opacity-85")
      ) ?? null
    );
  }

  test("auto-collapses on natural stream completion (still the last part)", () => {
    const streamingMessage = createReasoningMessage("Summary\nBody line", {
      isStreaming: true,
      isLastPartOfMessage: true,
    });
    const view = render(<ReasoningMessage message={streamingMessage} />);

    // Initially expanded while streaming.
    expect(getReasoningContentContainer(view.container)?.getAttribute("aria-hidden")).toBe("false");

    // Stream ends with this reasoning still being the terminal block — user should
    // see a clean collapse (the common "done thinking" UX).
    const settledMessage = createReasoningMessage("Summary\nBody line", {
      isStreaming: false,
      isLastPartOfMessage: true,
    });
    view.rerender(<ReasoningMessage message={settledMessage} />);

    expect(getReasoningContentContainer(view.container)?.getAttribute("aria-hidden")).toBe("true");
  });

  test("does NOT auto-collapse when another part displaces the reasoning mid-turn", () => {
    // This locks in the core tear fix. Previously, as soon as a text/tool part
    // appended to the assistant message, the reasoning part's isStreaming flipped
    // false *and* isLastPartOfMessage flipped false in the same snapshot, and the
    // component would animate height:0 over 200ms. Now we only auto-collapse when
    // the reasoning is still the terminal block.
    const streamingMessage = createReasoningMessage("Summary\nBody line", {
      isStreaming: true,
      isLastPartOfMessage: true,
    });
    const view = render(<ReasoningMessage message={streamingMessage} />);
    expect(getReasoningContentContainer(view.container)?.getAttribute("aria-hidden")).toBe("false");

    const displacedMessage = createReasoningMessage("Summary\nBody line", {
      isStreaming: false,
      isLastPartOfMessage: false,
    });
    view.rerender(<ReasoningMessage message={displacedMessage} />);

    // Reasoning stays expanded (aria-hidden=false) so the user can continue reading
    // it while the assistant's follow-on text/tool renders below.
    expect(getReasoningContentContainer(view.container)?.getAttribute("aria-hidden")).toBe("false");
  });

  test("does not apply the height transition class while content is streaming", () => {
    // Guards against the prior 200ms height transition that clipped newly arrived
    // tokens during streaming. During streaming, the content container renders
    // with height: auto and no transition so tokens land immediately.
    const streamingMessage = createReasoningMessage("Summary\nBody", {
      isStreaming: true,
      isLastPartOfMessage: true,
    });
    const { container } = render(<ReasoningMessage message={streamingMessage} />);

    // Two candidate inner wrappers exist (header + content). Find the content
    // container by its characteristic italic/opacity classes.
    const contentContainer = Array.from(container.querySelectorAll("div")).find((el) =>
      el.className.includes("italic opacity-85")
    );
    expect(contentContainer).toBeDefined();
    expect(contentContainer?.className).not.toMatch(/\btransition-\[height,opacity\]\b/);
    expect(contentContainer?.className).not.toMatch(/\boverflow-hidden\b/);
  });
});
