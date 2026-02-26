import "../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";

// lottie-web probes canvas on import, which crashes in happy-dom.
void mock.module("lottie-react", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "lottie-mock", ...props }),
}));

import { LoadingScreen } from "./LoadingScreen";
import { ThemeProvider } from "../contexts/ThemeContext";

let cleanupDom: (() => void) | null = null;

describe("LoadingScreen", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders the boot loader markup with loading animation", () => {
    const { getByRole, getByText } = render(
      <ThemeProvider>
        <LoadingScreen />
      </ThemeProvider>
    );

    expect(getByRole("status")).toBeTruthy();
    expect(getByText("Loading workspaces...")).toBeTruthy();
  });

  test("renders custom statusText", () => {
    const { getByText } = render(
      <ThemeProvider>
        <LoadingScreen statusText="Reconnecting..." />
      </ThemeProvider>
    );

    expect(getByText("Reconnecting...")).toBeTruthy();
  });
});
