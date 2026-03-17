import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactNode } from "react";
import { formatRelativeTime, formatTimestamp } from "@/browser/utils/ui/dateTime";
import type { BrowserAction, BrowserSession } from "@/common/types/browserSession";

let mockSession: BrowserSession | null = null;
let mockRecentActions: BrowserAction[] = [];
let mockError: string | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: null,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  TooltipProvider: (props: { children: ReactNode }) => props.children,
  Tooltip: (props: { children: ReactNode }) => props.children,
  TooltipTrigger: (props: { children: ReactNode }) => props.children,
  TooltipContent: (props: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{props.children}</div>
  ),
}));

void mock.module("./useBrowserSessionSubscription", () => ({
  useBrowserSessionSubscription: () => ({
    session: mockSession,
    recentActions: mockRecentActions,
    error: mockError,
  }),
}));

import { BrowserTab } from "./BrowserTab";

function createSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    status: "live",
    currentUrl: "https://example.com",
    title: "Example page",
    lastScreenshotBase64: null,
    lastError: null,
    streamState: "live",
    lastFrameMetadata: {
      deviceWidth: 1280,
      deviceHeight: 720,
      pageScaleFactor: 1,
      offsetTop: 0,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
    streamErrorMessage: null,
    startedAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    ...overrides,
  };
}

function renderBrowserTab() {
  return render(<BrowserTab workspaceId="workspace-1" />);
}

describe("BrowserTab recent action timestamps", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;

    mockSession = null;
    mockRecentActions = [];
    mockError = null;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("shows a single combined header badge", () => {
    mockSession = createSession();

    const liveView = renderBrowserTab();

    expect(liveView.getAllByText("Live")).toHaveLength(1);
    expect(liveView.queryByText("Stream live")).toBeNull();

    liveView.unmount();

    mockSession = createSession({ status: "ended", streamState: null, title: "Ended page" });

    const endedView = renderBrowserTab();

    expect(endedView.getAllByText("Ended")).toHaveLength(1);
    expect(endedView.queryByText("Stream live")).toBeNull();
  });

  test("shows stream-specific combined header badges for live sessions", () => {
    mockSession = createSession({ streamState: "fallback" });

    const fallbackView = renderBrowserTab();

    expect(fallbackView.getAllByText("Fallback")).toHaveLength(1);

    fallbackView.unmount();

    mockSession = createSession({ streamState: "restart_required", title: "Restart page" });

    const restartRequiredView = renderBrowserTab();

    expect(restartRequiredView.getAllByText("Restart required")).toHaveLength(1);

    restartRequiredView.unmount();

    mockSession = createSession({ streamState: "error", title: "Error page" });

    const streamErrorView = renderBrowserTab();

    expect(streamErrorView.getAllByText("Stream error")).toHaveLength(1);
  });

  test("labels custom scroll summaries as scroll actions", () => {
    mockRecentActions = [
      {
        id: "scroll-action-1",
        type: "custom",
        description: "Scrolled down ×3",
        timestamp: new Date("2026-03-16T00:01:00.000Z").toISOString(),
        metadata: {
          source: "user-input",
          inputKind: "scroll",
          scrollDirection: "down",
          scrollCount: 3,
        },
      },
    ];

    const view = renderBrowserTab();

    expect(view.getByText("Scrolled down ×3")).toBeTruthy();
    expect(view.getByText("scroll")).toBeTruthy();
    expect(view.queryByText("custom")).toBeNull();
  });

  test("uses the custom tooltip instead of a native title attribute for valid timestamps", () => {
    const timestamp = Date.now() - 60_000;
    const relativeLabel = formatRelativeTime(timestamp);
    const absoluteLabel = formatTimestamp(timestamp);
    mockRecentActions = [
      {
        id: "action-1",
        type: "navigate",
        description: "Navigate",
        timestamp: new Date(timestamp).toISOString(),
      },
    ];

    const view = renderBrowserTab();
    const timeLabel = view.getByText(relativeLabel);

    expect(timeLabel.getAttribute("title")).toBeNull();
    expect(view.getByText(absoluteLabel)).toBeTruthy();
  });
});
