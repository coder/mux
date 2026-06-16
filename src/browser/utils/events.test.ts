import "../../../tests/ui/dom";

import { describe, expect, test } from "bun:test";
import { isEventFromDialogPortal } from "./events";

describe("isEventFromDialogPortal", () => {
  test("detects targets inside role=dialog ancestors", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);

    expect(isEventFromDialogPortal(button)).toBe(true);
  });

  test("returns false for non-dialog targets and null", () => {
    const button = document.createElement("button");
    document.body.append(button);

    expect(isEventFromDialogPortal(button)).toBe(false);
    expect(isEventFromDialogPortal(null)).toBe(false);
  });
});
