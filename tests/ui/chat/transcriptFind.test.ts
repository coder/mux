import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { findTranscriptTextMatches } from "@/browser/utils/messages/transcriptSearch";

function getMessageWindow(container: HTMLElement): HTMLElement {
  const messageWindows = Array.from(
    container.querySelectorAll('[data-testid="message-window"]')
  ) as HTMLElement[];
  const messageWindow = messageWindows.at(-1);
  if (!(messageWindow instanceof HTMLElement)) {
    throw new Error("Message window not found");
  }
  return messageWindow;
}

function getTranscriptFindMatchLabel(input: HTMLInputElement): string {
  const findBar = input.closest('[data-testid="transcript-find-bar"]');
  if (!(findBar instanceof HTMLElement)) {
    throw new Error("Transcript find bar not found");
  }

  const matchLabel = findBar.querySelector("span");
  if (!(matchLabel instanceof HTMLElement)) {
    throw new Error("Transcript find match label not found");
  }

  return matchLabel.textContent?.trim() ?? "";
}

function parseMatchLabel(label: string): { current: number; total: number } | null {
  const match = /^(\d+)\/(\d+)$/.exec(label);
  if (!match) {
    return null;
  }

  return { current: Number(match[1]), total: Number(match[2]) };
}

async function openTranscriptFind(container: HTMLElement): Promise<HTMLInputElement> {
  const messageWindow = getMessageWindow(container);
  messageWindow.focus();
  fireEvent.keyDown(messageWindow, { key: "f", ctrlKey: true });

  const input = await waitFor(
    () => {
      const inputs = Array.from(
        container.querySelectorAll('input[aria-label="Find in transcript"]')
      ) as HTMLInputElement[];
      const element = inputs.at(-1);
      if (!(element instanceof HTMLInputElement)) {
        throw new Error("Transcript find input not found");
      }
      return element;
    },
    { timeout: 10_000 }
  );

  await waitFor(() => {
    expect(document.activeElement).toBe(input);
  });

  return input;
}

async function closeTranscriptFind(container: HTMLElement, input: HTMLInputElement): Promise<void> {
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() => {
    expect(container.querySelector('[data-testid="transcript-find-bar"]')).toBeNull();
  });
}

describe("Transcript find UI", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("supports keyboard open, typing focus, empty-enter close, and Enter navigation", async () => {
    const app = await createAppHarness({ branchPrefix: "transcript-find" });
    const user = userEvent.setup({ document: app.view.container.ownerDocument });

    try {
      await app.chat.send("needle-alpha needle-alpha");
      await app.chat.expectTranscriptContains("Mock response: needle-alpha needle-alpha");
      await app.chat.expectStreamComplete();

      const transcriptRoot = getMessageWindow(app.view.container);
      expect(findTranscriptTextMatches({ transcriptRoot, query: "n" }).length).toBeGreaterThan(0);
      expect(
        findTranscriptTextMatches({ transcriptRoot, query: "needle-alpha" }).length
      ).toBeGreaterThan(1);

      // Ctrl/Cmd+F opens transcript find and focuses the input.
      let input = await openTranscriptFind(app.view.container);
      expect(input.value).toBe("");
      await closeTranscriptFind(app.view.container, input);

      // Typing should keep focus in the find input (regression coverage).
      input = await openTranscriptFind(app.view.container);
      await user.type(input, "n");
      await waitFor(() => {
        expect(input.value).toBe("n");
        expect(getTranscriptFindMatchLabel(input)).not.toBe("Type to search");
        expect(document.activeElement).toBe(input);
      });
      await closeTranscriptFind(app.view.container, input);

      // Enter on an empty/whitespace query closes find and returns transcript focus.
      input = await openTranscriptFind(app.view.container);
      await user.clear(input);
      await user.type(input, "   ");
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        expect(app.view.container.querySelector('[data-testid="transcript-find-bar"]')).toBeNull();
      });
      expect(document.activeElement).toBe(getMessageWindow(app.view.container));

      // Enter/Shift+Enter navigate forward/backward through matches.
      input = await openTranscriptFind(app.view.container);
      await user.clear(input);
      await user.type(input, "needle-alpha");

      const firstMatch = await waitFor(() => {
        const parsed = parseMatchLabel(getTranscriptFindMatchLabel(input));
        if (!parsed || parsed.total < 2) {
          throw new Error("Expected at least two transcript matches");
        }
        return parsed;
      });

      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        const parsed = parseMatchLabel(getTranscriptFindMatchLabel(input));
        expect(parsed).not.toBeNull();
        expect(parsed?.total).toBe(firstMatch.total);
        expect(parsed?.current).toBe((firstMatch.current % firstMatch.total) + 1);
      });

      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
      await waitFor(() => {
        const parsed = parseMatchLabel(getTranscriptFindMatchLabel(input));
        expect(parsed).not.toBeNull();
        expect(parsed?.total).toBe(firstMatch.total);
        expect(parsed?.current).toBe(firstMatch.current);
      });
      await closeTranscriptFind(app.view.container, input);
    } finally {
      await app.dispose();
    }
  }, 90_000);
});
