import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CommandSuggestions } from "./CommandSuggestions";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";

function makeSuggestion(id: string): SlashSuggestion {
  return {
    id,
    display: id,
    description: `desc:${id}`,
    replacement: id,
  };
}

describe("CommandSuggestions", () => {
  let originalScrollIntoView: ((...args: unknown[]) => unknown) | undefined;

  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    const prototype = globalThis.window.HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => unknown;
    };

    originalScrollIntoView = prototype.scrollIntoView;
    prototype.scrollIntoView = () => undefined;
  });

  afterEach(() => {
    cleanup();

    const prototype = globalThis.window.HTMLElement.prototype as unknown as {
      scrollIntoView?: (...args: unknown[]) => unknown;
    };

    prototype.scrollIntoView = originalScrollIntoView;

    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  it("preserves the selected suggestion by id when suggestions reorder", () => {
    const initialSuggestions = [makeSuggestion("a"), makeSuggestion("b"), makeSuggestion("c")];
    const nextSuggestions = [makeSuggestion("c"), makeSuggestion("a"), makeSuggestion("b")];

    function Harness() {
      const [suggestions, setSuggestions] = React.useState(initialSuggestions);
      return (
        <div>
          <CommandSuggestions
            suggestions={suggestions}
            onSelectSuggestion={() => undefined}
            onDismiss={() => undefined}
            isVisible
          />
          <button onClick={() => setSuggestions(nextSuggestions)}>Update</button>
        </div>
      );
    }

    const { getByText } = render(<Harness />);

    // Move selection from 'a' -> 'b'
    fireEvent.keyDown(document, { key: "ArrowDown" });

    expect(getByText("b").closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true");

    // Reorder suggestions; selection should follow 'b'
    fireEvent.click(getByText("Update"));

    expect(getByText("b").closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("clamps the selection when the selected suggestion disappears", () => {
    const initialSuggestions = [makeSuggestion("a"), makeSuggestion("b"), makeSuggestion("c")];
    const nextSuggestions = [makeSuggestion("a"), makeSuggestion("b")];

    function Harness() {
      const [suggestions, setSuggestions] = React.useState(initialSuggestions);
      return (
        <div>
          <CommandSuggestions
            suggestions={suggestions}
            onSelectSuggestion={() => undefined}
            onDismiss={() => undefined}
            isVisible
          />
          <button onClick={() => setSuggestions(nextSuggestions)}>Update</button>
        </div>
      );
    }

    const { getByText } = render(<Harness />);

    // Move selection from 'a' -> 'c'
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" });

    expect(getByText("c").closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true");

    // Remove 'c'; selection should clamp (no out-of-range)
    fireEvent.click(getByText("Update"));

    expect(getByText("b").closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
  });
});
