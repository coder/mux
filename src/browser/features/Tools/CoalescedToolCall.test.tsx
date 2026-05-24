import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

import { CoalescedToolCall } from "./CoalescedToolCall";

const noop = (): void => undefined;

let windowInstance: GlobalWindow | null = null;

beforeEach(() => {
  windowInstance = new GlobalWindow();
  globalThis.window = windowInstance as unknown as Window & typeof globalThis;
  globalThis.document = windowInstance.document as unknown as Document;
});

afterEach(() => {
  cleanup();
  void windowInstance?.happyDOM.abort();
  windowInstance = null;
  delete (globalThis as { window?: Window }).window;
  delete (globalThis as { document?: Document }).document;
});

describe("CoalescedToolCall", () => {
  test("renders 'Read files <paths>' summary when collapsed", () => {
    const view = render(
      <TooltipProvider>
        <CoalescedToolCall
          kind="file_read"
          filePaths={["src/App.tsx", "src/main.ts"]}
          expanded={false}
          onToggle={noop}
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Read files/)).toBeTruthy();
    expect(view.getByText("src/App.tsx, src/main.ts")).toBeTruthy();
  });

  test("renders 'Wrote files' for file_edit kind", () => {
    const view = render(
      <TooltipProvider>
        <CoalescedToolCall
          kind="file_edit"
          filePaths={["a.ts", "b.ts", "c.ts"]}
          expanded={false}
          onToggle={noop}
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Wrote files/)).toBeTruthy();
  });

  test("clicking the header fires onToggle and reflects aria-expanded state", () => {
    const onToggle = mock(noop);
    const view = render(
      <TooltipProvider>
        <CoalescedToolCall
          kind="file_read"
          filePaths={["a.ts", "b.ts"]}
          expanded={false}
          onToggle={onToggle}
        />
      </TooltipProvider>
    );

    const header = view.container.querySelector('[aria-expanded="false"]');
    expect(header).toBeTruthy();
    fireEvent.click(header!);
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.rerender(
      <TooltipProvider>
        <CoalescedToolCall
          kind="file_read"
          filePaths={["a.ts", "b.ts"]}
          expanded={true}
          onToggle={onToggle}
        />
      </TooltipProvider>
    );

    expect(view.container.querySelector('[aria-expanded="true"]')).toBeTruthy();
  });

  test("uses singular noun for a single-path group", () => {
    const view = render(
      <TooltipProvider>
        <CoalescedToolCall
          kind="file_read"
          filePaths={["only.ts"]}
          expanded={false}
          onToggle={noop}
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Read file\b/)).toBeTruthy();
  });

  test("deduplicates repeated file paths while preserving first-occurrence order", () => {
    const view = render(
      <TooltipProvider>
        <CoalescedToolCall
          kind="file_edit"
          filePaths={["a.ts", "b.ts", "a.ts", "c.ts", "b.ts"]}
          expanded={false}
          onToggle={noop}
        />
      </TooltipProvider>
    );

    // Order kept by first occurrence; duplicates removed from the rendered list.
    expect(view.getByText("a.ts, b.ts, c.ts")).toBeTruthy();
    // Plural noun reflects the unique count (3), not the raw tool-call count (5).
    expect(view.getByText(/Wrote files/)).toBeTruthy();
  });
});
