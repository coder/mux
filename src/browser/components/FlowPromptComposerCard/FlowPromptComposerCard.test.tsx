import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { FlowPromptState } from "@/common/orpc/types";
import { FlowPromptComposerCard } from "./FlowPromptComposerCard";

function createState(overrides?: Partial<FlowPromptState>): FlowPromptState {
  return {
    workspaceId: "workspace-1",
    path: "/tmp/workspace/.mux/prompts/feature.md",
    exists: true,
    hasNonEmptyContent: true,
    modifiedAtMs: 1,
    contentFingerprint: "flow-prompt-fingerprint",
    lastEnqueuedFingerprint: null,
    isCurrentVersionEnqueued: false,
    hasPendingUpdate: false,
    autoSendMode: "off",
    updatePreviewText: null,
    ...overrides,
  };
}

describe("FlowPromptComposerCard", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders the diff preview without the boilerplate wrapper text", () => {
    const diffPreviewText = [
      "[Flow prompt updated. Follow current agent instructions.]",
      "",
      "Flow prompt file path: /tmp/workspace/.mux/prompts/feature.md (MUST use this exact path string for tool calls; do NOT rewrite it into another form, even if it resolves to the same file)",
      "",
      "Latest flow prompt changes:",
      "```diff",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
      "```",
    ].join("\n");

    const view = render(
      <ThemeProvider forcedTheme="dark">
        <FlowPromptComposerCard
          state={createState({ updatePreviewText: diffPreviewText })}
          onOpen={() => undefined}
          onDisable={() => undefined}
          onSendNow={() => undefined}
          onToggleCollapsed={() => undefined}
          onAutoSendModeChange={() => undefined}
        />
      </ThemeProvider>
    );

    expect(view.container.textContent).not.toContain("Flow prompt file path:");
    expect(view.container.textContent).not.toContain("[Flow prompt updated.");
    expect(view.container.textContent).not.toContain("Latest flow prompt changes:");
    expect(view.container.textContent).toContain("+new line");
    expect(view.getByText("Live flow prompt diff")).toBeTruthy();
  });

  test("renders a minimizable horizontal strip that can expand again", () => {
    const onToggleCollapsed = mock(() => undefined);
    const view = render(
      <FlowPromptComposerCard
        state={createState()}
        isCollapsed
        onOpen={() => undefined}
        onDisable={() => undefined}
        onSendNow={() => undefined}
        onToggleCollapsed={onToggleCollapsed}
        onAutoSendModeChange={() => undefined}
      />
    );

    expect(view.getByTestId("flow-prompt-composer-strip")).toBeTruthy();
    expect(view.container.textContent).toContain("Flow Prompting");
    fireEvent.click(view.getByLabelText("Expand Flow Prompting composer"));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});
