import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";

void mock.module("@/browser/contexts/API", () => ({
  APIProvider: (props: { children: React.ReactNode }) => props.children,
  useAPI: () => ({
    api: null,
    status: "auth_required" as const,
    error: "Authentication required",
    authenticate: () => undefined,
    retry: () => undefined,
  }),
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
    const { getByTestId, queryByText } = render(<AppLoader />);

    expect(queryByText("Loading workspaces...")).toBeNull();
    expect(getByTestId("AuthTokenModalMock").textContent).toContain("Authentication required");
  });
});
