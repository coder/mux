import React from "react";
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { MuxMessage } from "@/common/types/message";
import { MessageWindow } from "./MessageWindow";

void mock.module("@/browser/contexts/ChatHostContext", () => ({
  useChatHostContext: () => ({
    uiSupport: { jsonRawView: "unsupported" as const },
  }),
}));

void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

// Minimal message factory covering the three flag combinations we care about.
function createAssistantMessage(overrides: {
  isStreaming?: boolean;
  isLastPartOfMessage?: boolean;
  isPartial?: boolean;
}): MuxMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    historySequence: 1,
    parts: [],
    metadata: { model: "test-model", partial: overrides.isPartial ? true : undefined },
    // The meta-row gate reads these fields off a DisplayedMessage-like object, but
    // MessageWindow accepts the broader union. Cast is safe because the consumer
    // only touches the fields we populate.
    ...(overrides as object),
  } as unknown as MuxMessage;
}

describe("MessageWindow meta-row stability", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("hides the meta row while an assistant part is still streaming", () => {
    // Before the fix, an actively streaming part with isLastPartOfMessage=true
    // rendered the meta row — which then vanished the moment the part stopped
    // being last (tool appended). Keeping the meta row hidden throughout active
    // streaming removes the mid-turn tear.
    const message = createAssistantMessage({
      isStreaming: true,
      isLastPartOfMessage: true,
      isPartial: false,
    });
    const { container } = render(
      <MessageWindow label="model" message={message} variant="assistant">
        <div>content</div>
      </MessageWindow>
    );

    const block = container.querySelector("[data-message-block]");
    expect(block).not.toBeNull();
    expect(block?.querySelector("[data-message-meta]")).toBeNull();
    expect(block?.className).not.toMatch(/\bmb-4\b/);
  });

  test("hides the meta row when the part is no longer last (another part displaced it)", () => {
    // After a tool call appends to an assistant message, the previous text part's
    // isLastPartOfMessage flips false. We must not keep (or re-render) a meta row
    // on the displaced part, otherwise the later-arriving tool's own content
    // would visually duplicate the meta information.
    const message = createAssistantMessage({
      isStreaming: false,
      isLastPartOfMessage: false,
      isPartial: false,
    });
    const { container } = render(
      <MessageWindow label="model" message={message} variant="assistant">
        <div>content</div>
      </MessageWindow>
    );

    const block = container.querySelector("[data-message-block]");
    expect(block?.querySelector("[data-message-meta]")).toBeNull();
    expect(block?.className).not.toMatch(/\bmb-4\b/);
  });

  test("shows the meta row and mb-4 only when the last part has settled", () => {
    // Natural terminal state: stream ended, part is still last, and not a
    // persisted partial. This is the single moment where the meta row and the
    // larger bottom margin should appear — one controlled reveal at the end of
    // the turn rather than a flicker during streaming.
    const message = createAssistantMessage({
      isStreaming: false,
      isLastPartOfMessage: true,
      isPartial: false,
    });
    const { container } = render(
      <MessageWindow label="model" message={message} variant="assistant">
        <div>content</div>
      </MessageWindow>
    );

    const block = container.querySelector("[data-message-block]");
    expect(block?.querySelector("[data-message-meta]")).not.toBeNull();
    expect(block?.className).toMatch(/\bmb-4\b/);
  });

  test("treats interrupted (isPartial) parts as not-settled even with isLastPartOfMessage", () => {
    // Partials remain answerable/rewriteable; they should not show the
    // end-of-turn meta affordances that imply the response is done.
    const message = createAssistantMessage({
      isStreaming: false,
      isLastPartOfMessage: true,
      isPartial: true,
    });
    const { container } = render(
      <MessageWindow label="model" message={message} variant="assistant">
        <div>content</div>
      </MessageWindow>
    );

    const block = container.querySelector("[data-message-block]");
    expect(block?.querySelector("[data-message-meta]")).toBeNull();
    expect(block?.className).not.toMatch(/\bmb-4\b/);
  });

  test("user messages keep the meta row regardless of part flags", () => {
    // The meta row on user messages carries edit affordances and should stay
    // visible; the new gate explicitly preserves variant === "user" behavior.
    const userMessage = {
      id: "user-1",
      role: "user",
      historySequence: 1,
      parts: [],
      metadata: {},
    } as unknown as MuxMessage;

    const { container } = render(
      <MessageWindow label={null} message={userMessage} variant="user">
        <div>hello</div>
      </MessageWindow>
    );

    const block = container.querySelector("[data-message-block]");
    expect(block?.querySelector("[data-message-meta]")).not.toBeNull();
  });
});
