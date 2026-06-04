import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { FileEditToolCall } from "./FileEditToolCall";

function renderWithProviders(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("FileEditToolCall expansion", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("does not mutate a present edit's expand state when the result arrives later", () => {
    // Expand state is seeded once at mount (no workspace preference here) and must not
    // be mutated when the result later arrives — that would be a layout flash. A row
    // that mounted expanded (pending) stays expanded, so the failure is shown
    // immediately instead of being auto-collapsed behind a second click.
    const view = renderWithProviders(
      <FileEditToolCall
        toolName="file_edit_replace_string"
        args={{ path: "src/example.ts", old_string: "old", new_string: "new" }}
        result={undefined}
        status="executing"
      />
    );

    expect(view.queryByText("Waiting for result")).not.toBeNull();

    view.rerender(
      <TooltipProvider>
        <FileEditToolCall
          toolName="file_edit_replace_string"
          args={{ path: "src/example.ts", old_string: "old", new_string: "new" }}
          result={{ success: false, error: "edit failed" }}
          status="failed"
        />
      </TooltipProvider>
    );

    // Still expanded — the failure is visible without re-expanding.
    expect(view.queryByText("edit failed")).not.toBeNull();

    // The user can still collapse it manually.
    fireEvent.click(view.getByText("src/example.ts"));
    expect(view.queryByText("edit failed")).toBeNull();
  });
});
