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

  it("accepts the selected suggestion on Enter (slash commands)", () => {
    const suggestions = [makeSuggestion("a"), makeSuggestion("b"), makeSuggestion("c")];
    let selected: SlashSuggestion | null = null;

    const { getByText } = render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={(s) => {
          selected = s;
        }}
        onDismiss={() => undefined}
        isVisible
        isFileSuggestion={false}
      />
    );

    // Navigate to 'b'
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(getByText("b").closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true");

    // Press Enter to accept
    fireEvent.keyDown(document, { key: "Enter" });

    expect(selected).not.toBeNull();
    expect(selected!.id).toBe("b");
  });

  it("accepts the selected suggestion on Tab", () => {
    const suggestions = [makeSuggestion("a"), makeSuggestion("b"), makeSuggestion("c")];
    let selected: SlashSuggestion | null = null;

    const { getByText } = render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={(s) => {
          selected = s;
        }}
        onDismiss={() => undefined}
        isVisible
      />
    );

    // Navigate to 'c'
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(getByText("c").closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true");

    // Press Tab to accept
    fireEvent.keyDown(document, { key: "Tab" });

    expect(selected).not.toBeNull();
    expect(selected!.id).toBe("c");
  });

  it("does not accept on Shift+Enter (allows newline)", () => {
    const suggestions = [makeSuggestion("a"), makeSuggestion("b")];
    let selected: SlashSuggestion | null = null;

    render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={(s) => {
          selected = s;
        }}
        onDismiss={() => undefined}
        isVisible
      />
    );

    // Press Shift+Enter (should not select)
    fireEvent.keyDown(document, { key: "Enter", shiftKey: true });

    expect(selected).toBeNull();
  });

  it("dismisses on Escape and stops propagation", () => {
    const suggestions = [makeSuggestion("a"), makeSuggestion("b")];
    let dismissed = false;
    let propagated = false;

    // Add a window listener to detect if event propagates
    const windowListener = () => {
      propagated = true;
    };
    window.addEventListener("keydown", windowListener);

    render(
      <CommandSuggestions
        suggestions={suggestions}
        onSelectSuggestion={() => undefined}
        onDismiss={() => {
          dismissed = true;
        }}
        isVisible
      />
    );

    // Press Escape
    fireEvent.keyDown(document, { key: "Escape" });

    expect(dismissed).toBe(true);
    expect(propagated).toBe(false);

    window.removeEventListener("keydown", windowListener);
  });
});
