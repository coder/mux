import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import { useTheme } from "../contexts/ThemeContext";

let apiStatus: "auth_required" | "connecting" = "auth_required";
let apiError: string | null = "Authentication required";

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

    return {
      api: null,
      status: "connecting" as const,
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    };
  },
}));

void mock.module("./LoadingScreen", () => ({
  LoadingScreen: () => {
    const { theme } = useTheme();
    return <div data-testid="LoadingScreenMock">{theme}</div>;
  },
}));

void mock.module("@/browser/components/AuthTokenModal", () => ({
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

import { AppLoader } from "./AppLoader";

describe("AppLoader", () => {
  beforeEach(() => {
    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders AuthTokenModal when API status is auth_required (before workspaces load)", () => {
    apiStatus = "auth_required";
    apiError = "Authentication required";

    const { getByTestId, queryByText } = render(<AppLoader />);

    expect(queryByText("Loading workspaces...")).toBeNull();
    expect(getByTestId("AuthTokenModalMock").textContent).toContain("Authentication required");
  });

  test("wraps LoadingScreen in ThemeProvider", () => {
    apiStatus = "connecting";
    apiError = null;

    const { getByTestId } = render(<AppLoader />);

    // If ThemeProvider is missing, useTheme() will throw.
    expect(getByTestId("LoadingScreenMock").textContent).toBeTruthy();
  });
});
