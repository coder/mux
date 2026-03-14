import "../../../../tests/ui/dom";

import React from "react";
import type { AppLoader as AppLoaderComponent } from "../AppLoader/AppLoader";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useTheme } from "../../contexts/ThemeContext";
import { installDom } from "../../../../tests/ui/dom";

let cleanupDom: (() => void) | null = null;

let apiStatus: "auth_required" | "connecting" | "error" = "auth_required";
let apiError: string | null = "Authentication required";

const passthroughRef = <T,>(value: T): T => value;

function installAppLoaderModuleMocks() {
  void mock.module("react-dnd", () => ({
    DndProvider: (props: { children: React.ReactNode }) => props.children,
    useDrag: () => [{ isDragging: false }, passthroughRef, () => undefined] as const,
    useDrop: () => [{ isOver: false }, passthroughRef] as const,
    useDragLayer: () => ({ isDragging: false, item: null, currentOffset: null }),
  }));

  void mock.module("react-dnd-html5-backend", () => ({
    HTML5Backend: {},
    getEmptyImage: () => null,
  }));

  // AppLoader imports App, which pulls in Lottie-based components. In happy-dom,
  // lottie-web's canvas bootstrap can throw during module evaluation.
  void mock.module("lottie-react", () => ({
    __esModule: true,
    default: () => <div data-testid="LottieMock" />,
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

  void mock.module("../../App", () => ({
    __esModule: true,
    // App imports the full sidebar tree (including react-dnd) even though these auth-path tests
    // only need AppLoader's pre-App branching. Keep the unit focused so cross-file DOM teardown
    // cannot trip react-dnd's MutationObserver bootstrap between test files.
    default: () => <div data-testid="AppMock" />,
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
}

let AppLoader: typeof AppLoaderComponent;

describe("AppLoader", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    installAppLoaderModuleMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- module mocks must be registered before loading AppLoader in bun tests.
    ({ AppLoader } = require("../AppLoader/AppLoader") as {
      AppLoader: typeof AppLoaderComponent;
    });
  });

  afterEach(() => {
    cleanup();
    mock.restore();
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
