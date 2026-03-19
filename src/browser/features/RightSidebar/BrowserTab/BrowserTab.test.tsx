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
import { getActionDisplayInfo } from "./browserActionDisplay";

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
    endReason: null,
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

function createAction(overrides: Partial<BrowserAction> = {}): BrowserAction {
  return {
    id: "action-1",
    type: "navigate",
    description: "Browser page changed",
    timestamp: new Date("2026-03-16T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

describe("getActionDisplayInfo", () => {
  test("prefers navigate titles and adds hostname context when a URL is available", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "Project dashboard",
            currentUrl: "https://example.com/projects/alpha?tab=overview",
          },
        })
      )
    ).toEqual({
      primaryText: "Project dashboard",
      secondaryText: "example.com",
      typeLabel: "navigate",
    });
  });

  test("appends navigate merge counts to title-based display text", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "Project dashboard",
            currentUrl: "https://example.com/projects/alpha?tab=overview",
            navigateCount: 3,
          },
        })
      )
    ).toEqual({
      primaryText: "Project dashboard ×3",
      secondaryText: "example.com",
      typeLabel: "navigate",
    });
  });

  test("omits navigate count suffixes when the count is missing or 1", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "Release notes",
            currentUrl: "https://example.com/releases/latest",
          },
        })
      )
    ).toEqual({
      primaryText: "Release notes",
      secondaryText: "example.com",
      typeLabel: "navigate",
    });

    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "Release notes",
            currentUrl: "https://example.com/releases/latest",
            navigateCount: 1,
          },
        })
      )
    ).toEqual({
      primaryText: "Release notes",
      secondaryText: "example.com",
      typeLabel: "navigate",
    });
  });

  test("keeps navigate titles without adding secondary text when no URL is available", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "Release notes",
            currentUrl: null,
          },
        })
      )
    ).toEqual({
      primaryText: "Release notes",
      typeLabel: "navigate",
    });
  });

  test("formats navigate URLs into compact host and pathname text when titles are missing", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "",
            currentUrl: "https://example.com/docs/getting-started?ref=sidebar",
          },
        })
      )
    ).toEqual({
      primaryText: "example.com/docs/getting-started",
      typeLabel: "navigate",
    });
  });

  test("ignores URL-like navigate titles and still formats the current URL", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "https://example.com/docs/getting-started?ref=title",
            currentUrl: "https://example.com/docs/getting-started?ref=current-url",
          },
        })
      )
    ).toEqual({
      primaryText: "example.com/docs/getting-started",
      typeLabel: "navigate",
    });
  });

  test("keeps colon-delimited navigate titles as primary text", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "Release notes: March 2026",
            currentUrl: "https://example.com/releases/march-2026",
          },
        })
      )
    ).toEqual({
      primaryText: "Release notes: March 2026",
      secondaryText: "example.com",
      typeLabel: "navigate",
    });

    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "Error: something went wrong",
            currentUrl: null,
          },
        })
      )
    ).toEqual({
      primaryText: "Error: something went wrong",
      typeLabel: "navigate",
    });
  });

  test("still treats http and https navigate titles as URL-like", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "https://example.com",
            currentUrl: "https://example.com",
          },
        })
      )
    ).toEqual({
      primaryText: "example.com",
      typeLabel: "navigate",
    });

    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "http://localhost:3000",
            currentUrl: "http://localhost:3000",
          },
        })
      )
    ).toEqual({
      primaryText: "localhost:3000",
      typeLabel: "navigate",
    });
  });

  test("falls back to the action description when navigate metadata is empty", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          description: "Fallback description",
          metadata: {
            title: null,
            currentUrl: null,
          },
        })
      )
    ).toEqual({
      primaryText: "Fallback description",
      typeLabel: "navigate",
    });
  });

  test("falls back gracefully when navigate URLs are malformed", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          description: "Malformed fallback",
          metadata: {
            title: null,
            currentUrl: "not a real url",
          },
        })
      )
    ).toEqual({
      primaryText: "Malformed fallback",
      typeLabel: "navigate",
    });
  });

  test("falls back gracefully when navigate metadata fields have unexpected types", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: { label: "Project dashboard" },
            currentUrl: "https://example.com/projects/alpha",
            navigateCount: "3",
          },
        })
      )
    ).toEqual({
      primaryText: "example.com/projects/alpha",
      typeLabel: "navigate",
    });
  });

  test("falls back gracefully when navigate metadata is not a record", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          description: "Corrupted fallback",
          metadata: "corrupted" as unknown as Record<string, unknown>,
        })
      )
    ).toEqual({
      primaryText: "Corrupted fallback",
      typeLabel: "navigate",
    });
  });

  test("keeps localhost ports in formatted navigate URLs", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "",
            currentUrl: "http://localhost:3000/foo?ref=sidebar",
          },
        })
      )
    ).toEqual({
      primaryText: "localhost:3000/foo",
      typeLabel: "navigate",
    });

    expect(
      getActionDisplayInfo(
        createAction({
          metadata: {
            title: "",
            currentUrl: "http://localhost:5173/foo?ref=sidebar",
          },
        })
      )
    ).toEqual({
      primaryText: "localhost:5173/foo",
      typeLabel: "navigate",
    });
  });

  test("leaves non-navigate actions unchanged", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          type: "click",
          description: "Clicked submit",
          metadata: {
            selector: "button[type=submit]",
          },
        })
      )
    ).toEqual({
      primaryText: "Clicked submit",
      typeLabel: "click",
    });
  });

  test("keeps scroll actions on the existing shared display path", () => {
    expect(
      getActionDisplayInfo(
        createAction({
          type: "custom",
          description: "Scrolled down ×3",
          metadata: {
            inputKind: "scroll",
            scrollDirection: "down",
            scrollCount: 3,
          },
        })
      )
    ).toEqual({
      primaryText: "Scrolled down ×3",
      typeLabel: "scroll",
    });
  });
});

describe("BrowserTab auto-start", () => {
  test("re-attaches automatically when the last visible session was agent-closed", async () => {
    mockSession = createSession({
      workspaceId: "workspace-ended-auto-start",
      status: "ended",
      streamState: null,
      endReason: "agent_closed",
    });

    render(<BrowserTab workspaceId="workspace-ended-auto-start" />);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockBrowserSessionApi?.start).toHaveBeenCalledTimes(1);
    expect(mockBrowserSessionApi?.start).toHaveBeenCalledWith({
      workspaceId: "workspace-ended-auto-start",
    });
  });

  test("does not auto-start when the last visible session is error", async () => {
    mockSession = createSession({
      workspaceId: "workspace-error-session",
      status: "error",
      streamState: "error",
      lastError: "missing agent-browser binary",
    });

    render(<BrowserTab workspaceId="workspace-error-session" />);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockBrowserSessionApi?.start).not.toHaveBeenCalled();
  });

  test("does not auto-start when the last visible session was closed outside Mux", async () => {
    mockSession = createSession({
      workspaceId: "workspace-external-close",
      status: "ended",
      streamState: null,
      endReason: "external_closed",
    });

    render(<BrowserTab workspaceId="workspace-external-close" />);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockBrowserSessionApi?.start).not.toHaveBeenCalled();
  });
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

  test("shows a neutral closed notice for agent-closed sessions", () => {
    mockSession = createSession({
      status: "ended",
      streamState: null,
      endReason: "agent_closed",
      lastScreenshotBase64: "frame-data",
      title: "Closed page",
    });

    const view = renderBrowserTab();

    expect(view.getAllByText("Ended")).toHaveLength(1);
    expect(view.getByRole("status").textContent).toContain("Browser session was closed");
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText("Error")).toBeNull();
  });

  test("shows a neutral placeholder for externally closed sessions without a screenshot", () => {
    mockSession = createSession({
      status: "ended",
      streamState: null,
      endReason: "external_closed",
      lastScreenshotBase64: null,
      lastFrameMetadata: null,
      title: "Closed page",
    });

    const view = renderBrowserTab();

    expect(view.getByText("Browser window closed")).toBeTruthy();
    expect(view.getByText(/closed outside Mux/)).toBeTruthy();
    expect(view.queryByText("Browser session error")).toBeNull();
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

  test("shows host context for consecutive navigate actions with the same title", () => {
    mockRecentActions = [
      createAction({
        id: "action-1",
        description: "Shared title",
        metadata: {
          title: "Shared title",
          currentUrl: "http://localhost:3000/projects/alpha",
        },
      }),
      createAction({
        id: "action-2",
        description: "Shared title",
        metadata: {
          title: "Shared title",
          currentUrl: "http://localhost:5173/projects/beta",
        },
      }),
    ];

    const view = renderBrowserTab();

    expect(view.getAllByText("Shared title")).toHaveLength(2);
    expect(view.getByText("localhost:3000")).toBeTruthy();
    expect(view.getByText("localhost:5173")).toBeTruthy();
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
