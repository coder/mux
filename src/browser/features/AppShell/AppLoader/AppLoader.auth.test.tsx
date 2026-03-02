import "../../../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { installDom } from "../../../../../tests/ui/dom";

// AppLoader transitively imports react-dnd, and @react-dnd/asap touches
// document APIs at module evaluation time.
// Install a full happy-dom instance before importing AppLoader.
installDom();

let cleanupDom: (() => void) | null = null;

let apiStatus: "auth_required" | "connecting" | "error" = "auth_required";
let apiError: string | null = "Authentication required";

// AppLoader imports App, which pulls in Lottie-based components. In happy-dom,
// lottie-web's canvas bootstrap can throw during module evaluation.
void mock.module("lottie-react", () => ({
  __esModule: true,
  default: () => <div data-testid="LottieMock" />,
}));

void mock.module("@/browser/App", () => ({
  __esModule: true,
  default: () => <div data-testid="AppMock" />,
}));

void mock.module("@/browser/contexts/API", () => ({
  APIProvider: (props: { children: React.ReactNode }) => props.children,
  useAPI: () => {
    if (apiStatus === "auth_required") {
      return {
        api: null,
        status: "auth_required" as const,
        error: apiError,
        authenticate: () => undefined,
        retry: () => undefined,
      };
    }

    if (apiStatus === "error") {
      return {
        api: null,
        status: "error" as const,
        error: apiError ?? "Connection error",
        authenticate: () => undefined,
        retry: () => undefined,
      };
    }

    return {
      api: null,
      status: "connecting" as const,
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    };
  },
}));

const noop = (): void => undefined;
const noopPromise = () => Promise.resolve();

const mockPolicyState = {
  source: "none" as const,
  status: { state: "disabled" as const },
  policy: null,
  loading: false,
  refresh: noopPromise,
};

const mockRouterState = {
  navigateToWorkspace: noop,
  navigateToProject: noop,
  navigateToHome: noop,
  navigateToSettings: noop,
  navigateFromSettings: noop,
  navigateToAnalytics: noop,
  navigateFromAnalytics: noop,
  currentWorkspaceId: null,
  currentSettingsSection: null,
  currentProjectId: null,
  currentProjectPathFromState: null,
  pendingSectionId: null,
  pendingDraftId: null,
  isAnalyticsOpen: false,
};

const mockProjectContextValue = {
  userProjects: new Map<string, unknown>(),
  systemProjectPath: null,
  resolveProjectPath: () => null,
  getProjectConfig: () => undefined,
  loading: true,
  refreshProjects: noopPromise,
  addProject: noop,
  removeProject: () => Promise.resolve({ success: true }),
  isProjectCreateModalOpen: false,
  openProjectCreateModal: noop,
  closeProjectCreateModal: noop,
  workspaceModalState: {
    isOpen: false,
    projectPath: null,
    projectName: "",
    branches: [],
    defaultTrunkBranch: undefined,
    loadErrorMessage: null,
    isLoading: false,
  },
  openWorkspaceModal: noopPromise,
  closeWorkspaceModal: noop,
  getBranchesForProject: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
  getSecrets: () => Promise.resolve([]),
  updateSecrets: noopPromise,
  createSection: () => Promise.resolve({ success: false, error: "not implemented" }),
  updateSection: () => Promise.resolve({ success: false, error: "not implemented" }),
  removeSection: () => Promise.resolve({ success: false, error: "not implemented" }),
  reorderSections: () => Promise.resolve({ success: false, error: "not implemented" }),
  assignWorkspaceToSection: () => Promise.resolve({ success: false, error: "not implemented" }),
  hasAnyProject: false,
  resolveNewChatProjectPath: () => null,
};

const mockWorkspaceMetadata = new Map<string, unknown>();
const mockWorkspaceActions = {
  workspaceDraftPromotionsByProject: {},
  promoteWorkspaceDraft: noop,
  createWorkspace: () =>
    Promise.resolve({
      projectPath: "",
      projectName: "",
      namedWorkspacePath: "",
      workspaceId: "",
    }),
  removeWorkspace: () => Promise.resolve({ success: true }),
  updateWorkspaceTitle: () => Promise.resolve({ success: true }),
  archiveWorkspace: () => Promise.resolve({ success: true }),
  unarchiveWorkspace: () => Promise.resolve({ success: true }),
  refreshWorkspaceMetadata: noopPromise,
  setWorkspaceMetadata: noop,
  selectedWorkspace: null,
  setSelectedWorkspace: noop,
  pendingNewWorkspaceProject: null,
  pendingNewWorkspaceSectionId: null,
  pendingNewWorkspaceDraftId: null,
  beginWorkspaceCreation: noop,
  workspaceDraftsByProject: {},
  createWorkspaceDraft: noop,
  updateWorkspaceDraftSection: noop,
  openWorkspaceDraft: noop,
  deleteWorkspaceDraft: noop,
  getWorkspaceInfo: () => Promise.resolve(null),
};

const mockWorkspaceContextValue = {
  workspaceMetadata: mockWorkspaceMetadata,
  loading: true,
  ...mockWorkspaceActions,
};

const mockWorkspaceStoreRaw = {
  setClient: noop,
  syncWorkspaces: noop,
};

const mockWorkspaceStoreSingleton = {
  subscribeFileModifyingTool: () => () => undefined,
  getFileModifyingToolMs: () => null,
  clearFileModifyingToolMs: noop,
  simulateFileModifyingToolEnd: noop,
  getWorkspaceSidebarState: () => ({}),
  addWorkspace: noop,
  setActiveWorkspaceId: noop,
};

const mockGitStatusStoreRaw = {
  setClient: noop,
  syncWorkspaces: noop,
  subscribeToFileModifications: noop,
};

const mockBackgroundBashStoreRaw = {
  setClient: noop,
};

let mockPRStatusStoreInstance = {
  setClient: noop,
};

class MockWorkspaceStore {
  setClient() {
    return undefined;
  }

  syncWorkspaces() {
    return undefined;
  }
}

class MockGitStatusStore {
  setClient() {
    return undefined;
  }

  syncWorkspaces() {
    return undefined;
  }

  subscribeToFileModifications() {
    return undefined;
  }
}

class MockBackgroundBashStore {
  setClient() {
    return undefined;
  }
}

class MockPRStatusStore {
  setClient() {
    return undefined;
  }
}

void mock.module("@/browser/contexts/PolicyContext", () => ({
  PolicyProvider: (props: { children: React.ReactNode }) => props.children,
  usePolicy: () => mockPolicyState,
}));

void mock.module("@/browser/contexts/RouterContext", () => ({
  RouterProvider: (props: { children: React.ReactNode }) => props.children,
  useRouter: () => mockRouterState,
}));

void mock.module("@/browser/contexts/ProjectContext", () => ({
  ProjectProvider: (props: { children: React.ReactNode }) => props.children,
  useProjectContext: () => mockProjectContextValue,
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  WorkspaceProvider: (props: { children: React.ReactNode }) => props.children,
  toWorkspaceSelection: (metadata: {
    id: string;
    projectPath: string;
    projectName: string;
    namedWorkspacePath: string;
  }) => ({
    workspaceId: metadata.id,
    projectPath: metadata.projectPath,
    projectName: metadata.projectName,
    namedWorkspacePath: metadata.namedWorkspacePath,
  }),
  useWorkspaceMetadata: () => ({
    workspaceMetadata: mockWorkspaceMetadata,
    loading: true,
  }),
  useWorkspaceActions: () => mockWorkspaceActions,
  useWorkspaceContext: () => mockWorkspaceContextValue,
  useOptionalWorkspaceContext: () => mockWorkspaceContextValue,
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  WorkspaceStore: MockWorkspaceStore,
  workspaceStore: mockWorkspaceStoreSingleton,
  useWorkspaceState: () => ({}),
  useWorkspaceStoreRaw: () => mockWorkspaceStoreRaw,
  useWorkspaceRecency: () => ({}),
  useWorkspaceSidebarState: () => ({}),
  useBashToolLiveOutput: () => "",
  useTaskToolLiveTaskId: () => null,
  useLatestStreamingBashId: () => null,
  useWorkspaceAggregator: () => null,
  showAllMessages: noop,
  addEphemeralMessage: noop,
  removeEphemeralMessage: noop,
  useWorkspaceUsage: () => ({}),
  useWorkspaceStatsSnapshot: () => null,
  useWorkspaceConsumers: () => ({}),
}));

void mock.module("@/browser/stores/GitStatusStore", () => ({
  GitStatusStore: MockGitStatusStore,
  useGitStatus: () => null,
  useGitStatusRefreshing: () => false,
  useGitStatusStoreRaw: () => mockGitStatusStoreRaw,
  invalidateGitStatus: noop,
}));

void mock.module("@/browser/stores/BackgroundBashStore", () => ({
  BackgroundBashStore: MockBackgroundBashStore,
  useBackgroundBashStoreRaw: () => mockBackgroundBashStoreRaw,
  useBackgroundProcesses: () => [],
  useForegroundBashToolCallIds: () => new Set<string>(),
  useBackgroundBashTerminatingIds: () => new Set<string>(),
}));

void mock.module("@/browser/stores/PRStatusStore", () => ({
  PRStatusStore: MockPRStatusStore,
  getPRStatusStoreInstance: () => mockPRStatusStoreInstance,
  setPRStatusStoreInstance: (store: { setClient: () => void }) => {
    mockPRStatusStoreInstance = store;
  },
  useWorkspacePR: () => null,
}));

void mock.module("@/browser/components/LoadingScreen/LoadingScreen", () => ({
  LoadingScreen: () => {
    const { theme } = useTheme();
    return <div data-testid="LoadingScreenMock">{theme}</div>;
  },
}));

void mock.module("@/browser/components/StartupConnectionError/StartupConnectionError", () => ({
  StartupConnectionError: (props: { error: string }) => (
    <div data-testid="StartupConnectionErrorMock">{props.error}</div>
  ),
}));

void mock.module("@/browser/components/AuthTokenModal/AuthTokenModal", () => ({
  // Note: Module mocks leak between bun test files.
  // Export all commonly-used symbols to avoid cross-test import errors.
  AuthTokenModal: (props: { error?: string | null }) => (
    <div data-testid="AuthTokenModalMock">{props.error ?? "no-error"}</div>
  ),
  getStoredAuthToken: () => null,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setStoredAuthToken: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  clearStoredAuthToken: () => {},
}));

// eslint-disable-next-line no-restricted-syntax -- AppLoader imports react-dnd, which requires DOM globals during module evaluation.
const { AppLoader } = await import("./AppLoader");

describe("AppLoader", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders AuthTokenModal when API status is auth_required (before workspaces load)", () => {
    apiStatus = "auth_required";
    apiError = "Authentication required";

    const { getByTestId, queryByText } = render(<AppLoader />);

    expect(queryByText("Loading Mux")).toBeNull();
    expect(getByTestId("AuthTokenModalMock").textContent).toContain("Authentication required");
  });

  test("renders StartupConnectionError when API status is error (before workspaces load)", () => {
    apiStatus = "error";
    apiError = "Connection error";

    const { getByTestId, queryByTestId } = render(<AppLoader />);

    expect(queryByTestId("LoadingScreenMock")).toBeNull();
    expect(queryByTestId("AuthTokenModalMock")).toBeNull();
    expect(getByTestId("StartupConnectionErrorMock").textContent).toContain("Connection error");
  });

  test("wraps LoadingScreen in ThemeProvider", () => {
    apiStatus = "connecting";
    apiError = null;

    const { getByTestId } = render(<AppLoader />);

    // If ThemeProvider is missing, useTheme() will throw.
    expect(getByTestId("LoadingScreenMock").textContent).toBeTruthy();
  });
});
