import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

interface MockWorkspaceState {
  loading?: boolean;
  isHydratingTranscript?: boolean;
}

let cleanupDom: (() => void) | null = null;
let workspaceState: MockWorkspaceState | undefined;

const openTerminalMock = mock(() => Promise.resolve());
const addReviewMock = mock(() => undefined);

// Mock lottie-react before importing WorkspaceShell.
void mock.module("lottie-react", () => ({
  __esModule: true,
  default: () => <div data-testid="lottie-animation" />,
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceState: () => workspaceState,
}));

void mock.module("@/browser/contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

void mock.module("@/browser/contexts/BackgroundBashContext", () => ({
  useBackgroundBashError: () => ({
    error: null,
    clearError: () => undefined,
    showError: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/useOpenTerminal", () => ({
  useOpenTerminal: () => openTerminalMock,
}));

void mock.module("@/browser/hooks/useReviews", () => ({
  useReviews: () => ({
    addReview: addReviewMock,
  }),
}));

void mock.module("../ConnectionStatusToast/ConnectionStatusToast", () => ({
  ConnectionStatusToast: () => null,
}));

import { WorkspaceShell } from "./WorkspaceShell";

const defaultProps = {
  workspaceId: "workspace-1",
  projectPath: "/projects/demo",
  projectName: "demo",
  workspaceName: "feature-branch",
  namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
  leftSidebarCollapsed: false,
  onToggleLeftSidebarCollapsed: () => undefined,
};

describe("WorkspaceShell loading placeholders", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    workspaceState = undefined;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    workspaceState = undefined;
    openTerminalMock.mockClear();
    addReviewMock.mockClear();
  });

  it("renders loading animation during hydration in web mode", () => {
    workspaceState = {
      isHydratingTranscript: true,
      loading: false,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);

    expect(view.getByText("Catching up with the agent...")).toBeTruthy();
    expect(view.getByTestId("lottie-animation")).toBeTruthy();
  });

  it("renders loading animation during workspace loading", () => {
    workspaceState = {
      loading: true,
      isHydratingTranscript: false,
    };

    const view = render(<WorkspaceShell {...defaultProps} />);

    expect(view.getByText("Loading workspace...")).toBeTruthy();
    expect(view.getByTestId("lottie-animation")).toBeTruthy();
  });
});
