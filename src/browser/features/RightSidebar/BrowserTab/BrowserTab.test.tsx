import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactNode } from "react";
import { formatRelativeTime, formatTimestamp } from "@/browser/utils/ui/dateTime";
import type { BrowserAction, BrowserSession } from "@/common/types/browserSession";

let mockSession: BrowserSession | null = null;
let mockRecentActions: BrowserAction[] = [];
let mockError: string | null = null;

interface BrowserSessionApiMock {
  start: ReturnType<typeof mock>;
  stop: ReturnType<typeof mock>;
  navigate: ReturnType<typeof mock>;
  sendInput: ReturnType<typeof mock>;
  subscribe: ReturnType<typeof mock>;
  getActive: ReturnType<typeof mock>;
}

let mockBrowserSessionApi: BrowserSessionApiMock | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockBrowserSessionApi ? { browserSession: mockBrowserSessionApi } : null,
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
  mockBrowserSessionApi = {
    start: mock(() => Promise.resolve(createSession())),
    stop: mock(() => Promise.resolve({ success: true })),
    navigate: mock(() => Promise.resolve({ success: true })),
    sendInput: mock(() => Promise.resolve({ success: true })),
    subscribe: mock(() =>
      Promise.resolve({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<never>((resolve) => {
              void resolve;
            }),
        }),
      })
    ),
    getActive: mock(() => Promise.resolve(null)),
  };
});

afterEach(() => {
  cleanup();
  mock.restore();
  mockBrowserSessionApi = null;
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

describe("BrowserTab recent action timestamps", () => {
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

  test("shows degraded stream-state header badges for live sessions", () => {
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

describe("BrowserTab address bar and reload", () => {
  test("renders address field with current URL when session is active", () => {
    mockSession = createSession({ currentUrl: "https://example.com" });

    const view = renderBrowserTab();
    const input = view.getByPlaceholderText("Enter a URL…") as HTMLInputElement;

    expect(input.value).toBe("https://example.com");
  });

  test("shows empty placeholder instead of about:blank", () => {
    mockSession = createSession({ currentUrl: "about:blank" });

    const view = renderBrowserTab();
    const input = view.getByPlaceholderText("Enter a URL…") as HTMLInputElement;

    expect(input.value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("Enter a URL…");
  });

  test("shows Browser ready state when session is at about:blank", () => {
    mockSession = createSession({
      currentUrl: "about:blank",
      lastScreenshotBase64: "some-data",
    });

    const view = renderBrowserTab();

    expect(view.getByText("Browser ready")).toBeTruthy();
    expect(view.getByText("Enter a URL above or ask the agent to browse.")).toBeTruthy();
    expect(view.queryByAltText("Example page")).toBeNull();
  });

  test("hides ready state once a real URL is loaded", () => {
    mockSession = createSession({
      currentUrl: "https://example.com",
      lastScreenshotBase64: "abc123",
    });

    const view = renderBrowserTab();

    expect(view.queryByText("Browser ready")).toBeNull();
    expect(view.getByAltText("Example page")).toBeTruthy();
  });

  test("shows ready state even with non-live stream state at about:blank", () => {
    mockSession = createSession({
      currentUrl: "about:blank",
      streamState: "restart_required",
    });

    const view = renderBrowserTab();

    expect(view.getByText("Browser ready")).toBeTruthy();
  });

  test("submits valid URL on Enter", () => {
    mockSession = createSession({ currentUrl: "https://original.com" });

    const view = renderBrowserTab();
    const input = view.getByPlaceholderText("Enter a URL…") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "https://test.com" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockBrowserSessionApi?.navigate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      url: "https://test.com",
    });
  });

  test("shows inline error for unsafe URL", () => {
    mockSession = createSession();

    const view = renderBrowserTab();
    const input = view.getByPlaceholderText("Enter a URL…") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      view.getByText("Unsupported URL protocol. Only http:// and https:// URLs are allowed.")
    ).toBeTruthy();
    expect(mockBrowserSessionApi?.navigate).not.toHaveBeenCalled();
  });

  test("restores URL on Escape", () => {
    mockSession = createSession({ currentUrl: "https://original.com" });

    const view = renderBrowserTab();
    const input = view.getByPlaceholderText("Enter a URL…") as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "https://new.com" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.value).toBe("https://original.com");
  });

  test("reload button sends keyboard F5 via sendInput", () => {
    mockSession = createSession();

    const view = renderBrowserTab();
    const reloadButton = view.getByRole("button", { name: "Reload page" }) as HTMLButtonElement;

    fireEvent.click(reloadButton);

    expect(mockBrowserSessionApi?.sendInput).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      input: {
        kind: "keyboard",
        eventType: "keyDown",
        key: "F5",
        code: "F5",
      },
    });
  });

  test("reload button is disabled when stream is not live", () => {
    mockSession = createSession({ streamState: "restart_required" });

    const view = renderBrowserTab();
    const reloadButton = view.getByRole("button", { name: "Reload page" }) as HTMLButtonElement;

    expect(reloadButton.disabled).toBe(true);
  });

  test("address field is hidden when no session and not starting", () => {
    mockSession = null;

    const view = renderBrowserTab();

    expect(view.queryByPlaceholderText("Enter a URL…")).toBeNull();
  });
});
