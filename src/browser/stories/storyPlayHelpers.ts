import { userEvent, waitFor } from "@storybook/test";

/**
 * Wait for chat messages to finish loading.
 *
 * Waits for data-loaded="true" on the message window, then one RAF
 * to let any pending coalesced scroll from useAutoScroll complete.
 */
export async function waitForChatMessagesLoaded(canvasElement: HTMLElement): Promise<void> {
  // Use 25s timeout to handle CI cold-start scenarios where large dependencies
  // (Shiki, Mermaid) are still being loaded/initialized on busy runners
  await waitFor(
    () => {
      const messageWindow = canvasElement.querySelector('[data-testid="message-window"]');
      if (messageWindow?.getAttribute("data-loaded") !== "true") {
        throw new Error("Messages not loaded yet");
      }
    },
    { timeout: 25000 }
  );

  // One RAF to let any pending coalesced scroll complete
  await new Promise((r) => requestAnimationFrame(r));
}

export async function waitForChatInputAutofocusDone(canvasElement: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const state = canvasElement
        .querySelector('[data-component="ChatInputSection"]')
        ?.getAttribute("data-autofocus-state");
      if (state !== "done") {
        throw new Error("ChatInput auto-focus not finished");
      }
    },
    { timeout: 5000 }
  );
}

export function blurActiveElement(): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/**
 * Replace the contents of a controlled `<input>` / `<textarea>` deterministically.
 *
 * Why this exists: in play functions, the naive sequence
 *
 *     await userEvent.clear(input);
 *     await userEvent.type(input, "2");
 *
 * is a classic flake source for controlled inputs. `userEvent.clear` (and
 * the implicit click that `userEvent.type` performs before keystrokes) can
 * leave the field transiently empty between the two steps. When the input
 * has an `onBlur` handler that normalizes/resets the value (a very common
 * pattern for numeric settings), any blur landing in that window resets
 * the draft to a default; the subsequent `type("2")` then appends to it
 * ("42" instead of "2"), and `toHaveValue("2")` fails non-deterministically.
 *
 * This helper avoids that by overwriting the existing contents atomically:
 *
 *   1. Click the input (explicit focus + matches user-event's normal click
 *      semantics, so no surprise implicit click happens later that would
 *      collapse our selection).
 *   2. `setSelectionRange(0, length)` so the entire current value is selected
 *      AFTER the click. (We can't `input.select()` before the click — the
 *      click would collapse that selection. We also can't rely on
 *      `userEvent.type`'s `initialSelectionStart`/`End` options being
 *      preserved across user-event versions.)
 *   3. `userEvent.keyboard(value)` — keyboard dispatches to the focused
 *      element without performing another click, so the selection persists
 *      and the typed value replaces it in one shot. No transient empty
 *      state, no opportunity for an onBlur normalizer to reset the field.
 *   4. Wait for the DOM to settle on the expected value.
 *
 * Prefer this over raw `clear` + `type` whenever you need to assert the final
 * input value or trigger validation tied to a specific value.
 */
export async function replaceInputValue(
  input: HTMLElement,
  value: string,
  expectedValue: string = value
): Promise<void> {
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
    throw new Error("replaceInputValue: element is not an input or textarea");
  }
  await userEvent.click(input);
  input.setSelectionRange(0, input.value.length);
  await userEvent.keyboard(value);
  await waitFor(() => {
    if (input.value !== expectedValue) {
      throw new Error(
        `replaceInputValue: expected value ${JSON.stringify(expectedValue)}, got ${JSON.stringify(input.value)}`
      );
    }
  });
}

/**
 * Wait for chat messages to load and async rendering (markdown, etc.) to settle.
 *
 * Use this for stories with MarkdownRenderer content that changes element heights
 * after rendering, triggering ResizeObserver scroll. Waits for messages to load
 * plus double-RAF for coalesced scroll to fire and layout to settle.
 */
export async function waitForScrollStabilization(canvasElement: HTMLElement): Promise<void> {
  await waitForChatMessagesLoaded(canvasElement);

  // Wait 2 RAFs: one for coalesced scroll to fire, one for layout to settle
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}
