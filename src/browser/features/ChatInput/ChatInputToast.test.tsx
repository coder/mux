import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ChatInputToast, type Toast } from "./ChatInputToast";

describe("ChatInputToast", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("resets leaving state when a new toast is shown", async () => {
    const toast1: Toast = { id: "toast-1", type: "error", message: "first" };
    const toast2: Toast = { id: "toast-2", type: "error", message: "second" };

    function Harness() {
      const [toast, setToast] = React.useState<Toast | null>(toast1);
      return (
        <div>
          <ChatInputToast toast={toast} onDismiss={() => undefined} />
          <button onClick={() => setToast(toast2)}>Next toast</button>
        </div>
      );
    }

    const { getByLabelText, getByRole, getByText } = render(<Harness />);

    fireEvent.click(getByLabelText("Dismiss"));

    await waitFor(() => {
      expect(getByRole("alert").className).toContain("toastFadeOut");
    });

    fireEvent.click(getByText("Next toast"));

    await waitFor(() => {
      const className = getByRole("alert").className;
      expect(className).toContain("toastSlideIn");
      expect(className).not.toContain("toastFadeOut");
    });
  });
});
