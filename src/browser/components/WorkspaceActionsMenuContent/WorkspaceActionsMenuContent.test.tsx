import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { WorkspaceActionsMenuContent } from "./WorkspaceActionsMenuContent";

let cleanupDom: (() => void) | null = null;

describe("WorkspaceActionsMenuContent", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("opens automation settings as a workspace action", () => {
    const onConfigureAutomation = mock(() => undefined);
    const onCloseMenu = mock(() => undefined);
    const view = render(
      <WorkspaceActionsMenuContent
        onConfigureAutomation={onConfigureAutomation}
        onCloseMenu={onCloseMenu}
      />
    );

    expect(view.getByRole("button", { name: /Automations/ }).textContent).toContain(
      formatKeybind(KEYBINDS.CONFIGURE_SCHEDULED_WORKFLOW)
    );

    fireEvent.click(view.getByRole("button", { name: /Automations/ }));

    expect(onCloseMenu).toHaveBeenCalledTimes(1);
    expect(onConfigureAutomation).toHaveBeenCalledTimes(1);
  });
});
