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
