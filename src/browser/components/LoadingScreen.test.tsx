import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";

import { LoadingScreen } from "./LoadingScreen";

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

  test("renders the boot loader markup", () => {
    const { container, getByRole, getByText } = render(<LoadingScreen />);

    expect(getByRole("status")).toBeTruthy();
    expect(getByText("Loading workspaces...")).toBeTruthy();
    expect(container.querySelector(".boot-loader__spinner")).toBeTruthy();
  });

  test("renders custom statusText", () => {
    const { getByText } = render(<LoadingScreen statusText="Reconnecting..." />);

    expect(getByText("Reconnecting...")).toBeTruthy();
  });
});
