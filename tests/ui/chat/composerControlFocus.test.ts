import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { resolveComposerControlFocusTarget } from "@/browser/components/ChatPane/composerControlFocus";

describe("resolveComposerControlFocusTarget", () => {
  function buildDock() {
    const dock = document.createElement("div");
    const control = document.createElement("button");
    const label = document.createElement("span");
    control.append(label);
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    const textarea = document.createElement("textarea");
    const hint = document.createElement("span");
    dock.append(control, option, textarea, hint);

    const outside = document.createElement("button");
    document.body.append(dock, outside);

    return { dock, control, label, option, textarea, hint, outside };
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  test("resolves the enclosing control from a nested target", () => {
    const { dock, control, label, option } = buildDock();
    expect(resolveComposerControlFocusTarget(label, dock)).toBe(control);
    expect(resolveComposerControlFocusTarget(option, dock)).toBe(option);
  });

  test("ignores non-control targets and targets outside the dock", () => {
    const { dock, textarea, hint, outside, control } = buildDock();
    expect(resolveComposerControlFocusTarget(textarea, dock)).toBeNull();
    expect(resolveComposerControlFocusTarget(hint, dock)).toBeNull();
    expect(resolveComposerControlFocusTarget(outside, dock)).toBeNull();
    expect(resolveComposerControlFocusTarget(control, null)).toBeNull();
  });
});

describe("Composer control focus", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("claims focus for the pressed control instead of the transcript scrollport", async () => {
    const app = await createAppHarness({ branchPrefix: "composer-control-focus" });

    try {
      const messageWindow = app.view.container.querySelector<HTMLElement>(
        '[data-testid="message-window"]'
      );
      const dock = app.view.container.querySelector<HTMLElement>(
        '[data-testid="chat-composer-dock"]'
      );
      if (!messageWindow || !dock) throw new Error("Message window or composer dock not found");

      // The dock lives inside a focusable scrollport, which is what lets WebKit
      // hand it focus when a composer button is pressed.
      expect(messageWindow.contains(dock)).toBe(true);
      expect(messageWindow.tabIndex).toBe(0);

      const trigger = dock.querySelector<HTMLElement>(
        '[data-component="ModelSelectorGroup"] button'
      );
      if (!trigger) throw new Error("Model selector trigger not found");
      const label = trigger.querySelector("span") ?? trigger;

      expect(fireEvent.mouseDown(label)).toBe(false);
      expect(document.activeElement).toBe(trigger);

      const textarea = dock.querySelector("textarea");
      if (!textarea) throw new Error("Composer textarea not found");
      expect(fireEvent.mouseDown(textarea)).toBe(true);

      // The suppressed default must not cost the picker its click.
      fireEvent.click(trigger);
      const options = await waitFor(() => {
        const found = dock.querySelectorAll<HTMLElement>('[role="option"]');
        if (found.length === 0) throw new Error("Model options did not render");
        return found;
      });

      const option = options[0];
      fireEvent.mouseDown(option);
      fireEvent.click(option);
      await waitFor(() => {
        expect(dock.querySelectorAll('[role="option"]')).toHaveLength(0);
      });
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
