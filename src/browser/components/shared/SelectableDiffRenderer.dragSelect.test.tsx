import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { SelectableDiffRenderer } from "./DiffRenderer";

describe("SelectableDiffRenderer drag selection", () => {
  let onReviewNote: Mock<(data: unknown) => void>;

  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    onReviewNote = mock(() => undefined);
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("dragging on the indicator column selects a line range", async () => {
    const content = "+const a = 1;\n+const b = 2;\n+const c = 3;";

    const { container, getByPlaceholderText } = render(
      <ThemeProvider forcedTheme="dark">
        <SelectableDiffRenderer
          content={content}
          filePath="src/test.ts"
          onReviewNote={onReviewNote}
          maxHeight="none"
          enableHighlighting={false}
        />
      </ThemeProvider>
    );

    await waitFor(() => {
      const indicators = container.querySelectorAll('[data-diff-indicator="true"]');
      expect(indicators.length).toBe(3);
    });

    const indicators = Array.from(
      container.querySelectorAll<HTMLSpanElement>('[data-diff-indicator="true"]')
    );

    fireEvent.mouseDown(indicators[0], { button: 0 });
    fireEvent.mouseEnter(indicators[2]);
    fireEvent.mouseUp(window);

    const textarea = getByPlaceholderText(/Add a review note/i);
    fireEvent.change(textarea, { target: { value: "please review" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onReviewNote).toHaveBeenCalledTimes(1);
    });

    const callArg = onReviewNote.mock.calls[0]?.[0] as {
      selectedDiff?: string;
      userNote?: string;
      lineRange?: string;
    };

    expect(callArg.userNote).toBe("please review");
    expect(callArg.lineRange).toBe("+1-3");
    expect(callArg.selectedDiff).toBe(content);
  });
});
