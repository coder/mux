import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { FlowPromptState } from "@/common/orpc/types";
import { FlowPromptComposerCard, shouldShowFlowPromptComposerCard } from "./FlowPromptComposerCard";

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
    nextHeadingContent: null,
    updatePreviewText: null,
    ...overrides,
  };
}

type FlowPromptComposerCardTestProps = Parameters<typeof FlowPromptComposerCard>[0];

function renderCard(props: FlowPromptComposerCardTestProps) {
  return render(
    <TooltipProvider>
      <ThemeProvider forcedTheme="dark">
        <FlowPromptComposerCard {...props} />
      </ThemeProvider>
    </TooltipProvider>
  );
}

describe("FlowPromptComposerCard", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    const requestAnimationFrameMock: typeof requestAnimationFrame = (callback) => {
      return globalThis.setTimeout(() => callback(Date.now()), 0) as unknown as number;
    };
    const cancelAnimationFrameMock: typeof cancelAnimationFrame = (handle) => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>);
    };

    class ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {
        void _callback;
      }
      observe(_target: Element): void {
        void _target;
      }
      unobserve(_target: Element): void {
        void _target;
      }
      disconnect(): void {
        return undefined;
      }
    }

    globalThis.ResizeObserver = ResizeObserver;
    globalThis.window.ResizeObserver = ResizeObserver;
    globalThis.requestAnimationFrame = requestAnimationFrameMock;
    globalThis.cancelAnimationFrame = cancelAnimationFrameMock;
    globalThis.window.requestAnimationFrame = requestAnimationFrameMock;
    globalThis.window.cancelAnimationFrame = cancelAnimationFrameMock;
  });

  afterEach(() => {
    cleanup();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.ResizeObserver = originalResizeObserver;
    if (globalThis.window) {
      globalThis.window.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.window.cancelAnimationFrame = originalCancelAnimationFrame;
      globalThis.window.ResizeObserver = originalResizeObserver;
    }
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
      "Index: /tmp/workspace/.mux/prompts/feature.md",
      "===================================================================",
      "--- /tmp/workspace/.mux/prompts/feature.md",
      "+++ /tmp/workspace/.mux/prompts/feature.md",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
      "```",
    ].join("\n");

    const view = renderCard({
      state: createState({ updatePreviewText: diffPreviewText }),
      onOpen: () => undefined,
      onDisable: () => undefined,
      onSendNow: () => undefined,
      onToggleCollapsed: () => undefined,
      onAutoSendModeChange: () => undefined,
    });

    expect(view.container.textContent).not.toContain("Flow prompt file path:");
    expect(view.container.textContent).not.toContain("[Flow prompt updated.");
    expect(view.container.textContent).not.toContain("Latest flow prompt changes:");
    expect(view.container.querySelector('[data-diff-indicator="true"]')).toBeTruthy();
    expect(view.getByText("Live flow prompt diff")).toBeTruthy();
  });

  test("keeps prompt contents previews as contents even when the body mentions diff headers", () => {
    const contentsPreviewText = [
      "[Flow prompt updated. Follow current agent instructions.]",
      "",
      "Flow prompt file path: /tmp/workspace/.mux/prompts/feature.md (MUST use this exact path string for tool calls; do NOT rewrite it into another form, even if it resolves to the same file)",
      "",
      "Current flow prompt contents:",
      "```md",
      "Keep these exact notes in the prompt body:",
      "Latest flow prompt changes:",
      "```diff",
      "-not actually a diff preview",
      "+still just prompt contents",
      "```",
      "```",
    ].join("\n");

    const view = renderCard({
      state: createState({ updatePreviewText: contentsPreviewText }),
      onOpen: () => undefined,
      onDisable: () => undefined,
      onSendNow: () => undefined,
      onToggleCollapsed: () => undefined,
      onAutoSendModeChange: () => undefined,
    });

    expect(view.getByText("Live flow prompt contents")).toBeTruthy();
    expect(view.container.querySelector('[data-diff-indicator="true"]')).toBeNull();
    expect(view.container.textContent).toContain("still just prompt contents");
  });

  test("keeps the clear-update banner visible after the prompt file has been deleted", () => {
    const clearPreviewText = [
      "[Flow prompt updated. Follow current agent instructions.]",
      "",
      "Flow prompt file path: /tmp/workspace/.mux/prompts/feature.md (MUST use this exact path string for tool calls; do NOT rewrite it into another form, even if it resolves to the same file)",
      "",
      "The flow prompt file is now empty. Stop relying on any prior flow prompt instructions from that file unless the user saves new content.",
    ].join("\n");

    const view = renderCard({
      state: createState({
        exists: false,
        hasNonEmptyContent: false,
        updatePreviewText: clearPreviewText,
      }),
      onOpen: () => undefined,
      onDisable: () => undefined,
      onSendNow: () => undefined,
      onToggleCollapsed: () => undefined,
      onAutoSendModeChange: () => undefined,
    });

    expect(view.container.textContent).toContain("Send this clear update");
    expect(view.getByText("Live flow prompt clear")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Open prompt" })).toBeNull();
    expect(view.queryByRole("button", { name: "Disable" })).toBeNull();
  });

  test("keeps the composer visible when only a clear update remains", () => {
    expect(
      shouldShowFlowPromptComposerCard({
        exists: false,
        updatePreviewText: "The flow prompt file is now empty.",
        hasPendingUpdate: false,
      })
    ).toBe(true);
    expect(
      shouldShowFlowPromptComposerCard({
        exists: false,
        updatePreviewText: null,
        hasPendingUpdate: false,
      })
    ).toBe(false);
  });

  test("renders the parsed Next heading content above the diff preview", () => {
    const view = renderCard({
      state: createState({ nextHeadingContent: "Only work on stage 2 of the plan." }),
      onOpen: () => undefined,
      onDisable: () => undefined,
      onSendNow: () => undefined,
      onToggleCollapsed: () => undefined,
      onAutoSendModeChange: () => undefined,
    });

    expect(view.container.textContent).toContain("Next");
    expect(view.container.textContent).toContain("Only work on stage 2 of the plan.");
    expect(view.container.textContent).toContain("Sent with every Flow Prompt update");
  });

  test("keeps icon actions accessible without rendering their labels inline", () => {
    const state = createState();
    const view = renderCard({
      state,
      onOpen: () => undefined,
      onDisable: () => undefined,
      onSendNow: () => undefined,
      onToggleCollapsed: () => undefined,
      onAutoSendModeChange: () => undefined,
    });

    expect(view.getByRole("button", { name: "Send now" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy path" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Open prompt" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Disable" })).toBeTruthy();
    expect(view.container.textContent).toContain("Next");
    expect(view.getByTestId("flow-prompt-helper-row").className).toContain("md:col-span-2");
    expect(view.queryByText(/^Send now$/)).toBeNull();
    expect(view.container.textContent).not.toContain("Copy path");
    expect(view.container.textContent).not.toContain("Open prompt");
    expect(view.container.textContent).not.toContain("Disable");
    expect(view.container.textContent).not.toContain(state.path);
  });

  test("left-aligns the collapsed strip copy like the other composer accessories", () => {
    const view = renderCard({
      state: createState(),
      isCollapsed: true,
      onOpen: () => undefined,
      onDisable: () => undefined,
      onSendNow: () => undefined,
      onToggleCollapsed: () => undefined,
      onAutoSendModeChange: () => undefined,
    });

    expect(view.getByLabelText("Expand Flow Prompting composer").className).toContain("text-left");
  });

  test("renders a minimizable horizontal strip that can expand again", () => {
    const onToggleCollapsed = mock(() => undefined);
    const view = renderCard({
      state: createState(),
      isCollapsed: true,
      onOpen: () => undefined,
      onDisable: () => undefined,
      onSendNow: () => undefined,
      onToggleCollapsed,
      onAutoSendModeChange: () => undefined,
    });

    expect(view.getByTestId("flow-prompt-composer-strip")).toBeTruthy();
    expect(view.container.textContent).toContain("Flow Prompting");
    fireEvent.click(view.getByLabelText("Expand Flow Prompting composer"));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});
