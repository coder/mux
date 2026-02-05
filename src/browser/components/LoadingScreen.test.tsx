import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";

import { LoadingScreen } from "./LoadingScreen";

describe("LoadingScreen", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders the boot loader markup", () => {
    const { container, getByRole, getByText } = render(<LoadingScreen />);

    expect(getByRole("status")).toBeTruthy();
    expect(getByText("Loading workspaces...")).toBeTruthy();
    expect(container.querySelector(".boot-loader__spinner")).toBeTruthy();
  });
});
