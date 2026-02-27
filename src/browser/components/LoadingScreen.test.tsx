import "../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";

// SVG ?react imports don't work in happy-dom; stub them as simple divs.
const SvgStub = (props: Record<string, unknown>) =>
  React.createElement("svg", { "data-testid": "mux-logo-mock", ...props });

void mock.module("@/browser/assets/logos/mux-logo-dark.svg?react", () => ({
  __esModule: true,
  default: SvgStub,
}));
void mock.module("@/browser/assets/logos/mux-logo-light.svg?react", () => ({
  __esModule: true,
  default: SvgStub,
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

  test("renders boot loader markup with Mux logo and animated dots", () => {
    const { container, getByRole, getByTestId, getByText } = render(
      <ThemeProvider>
        <LoadingScreen />
      </ThemeProvider>
    );

    expect(getByRole("status")).toBeTruthy();
    expect(getByTestId("mux-logo-mock")).toBeTruthy();
    expect(getByText("Loading Mux")).toBeTruthy();
    // Animated dots span is present for default text
    expect(container.querySelector(".boot-loader__dots")).toBeTruthy();
  });

  test("renders custom statusText without animated dots", () => {
    const { container, getByText } = render(
      <ThemeProvider>
        <LoadingScreen statusText="Reconnecting..." />
      </ThemeProvider>
    );

    expect(getByText("Reconnecting...")).toBeTruthy();
    // Custom statusText supplies its own punctuation — no animated dots
    expect(container.querySelector(".boot-loader__dots")).toBeNull();
  });
});
