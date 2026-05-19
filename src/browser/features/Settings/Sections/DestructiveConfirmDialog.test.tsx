import "../../../../../tests/ui/dom";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { installDom } from "../../../../../tests/ui/dom";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";

function renderDialog(props: Partial<React.ComponentProps<typeof DestructiveConfirmDialog>> = {}) {
  const onConfirm = mock(() => undefined);
  const onClose = mock(() => undefined);
  const view = render(
    <ThemeProvider forcedTheme="dark">
      <DestructiveConfirmDialog
        isOpen
        title="Disable My Extension?"
        description="Disabling stops contributions until re-enabled."
        consequences={["Contribution availability ends.", "Approval record preserved."]}
        confirmLabel="Disable"
        onConfirm={onConfirm}
        onClose={onClose}
        {...props}
      />
    </ThemeProvider>
  );
  return { view, onConfirm, onClose };
}

describe("DestructiveConfirmDialog", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("does not render when isOpen=false", () => {
    const { view } = renderDialog({ isOpen: false });
    expect(view.queryByTestId("destructive-confirm-dialog")).toBeNull();
  });

  test("renders title, description, and consequences list", () => {
    const { view } = renderDialog();
    expect(view.getByText("Disable My Extension?")).toBeTruthy();
    expect(view.getByText(/Disabling stops contributions/)).toBeTruthy();
    expect(view.getByText("Contribution availability ends.")).toBeTruthy();
    expect(view.getByText("Approval record preserved.")).toBeTruthy();
  });

  test("Confirm button uses provided label", () => {
    const { view } = renderDialog({ confirmLabel: "Untrust root" });
    expect(view.getByLabelText("Confirm: Untrust root")).toBeTruthy();
  });

  test("Confirm invokes onConfirm; Cancel invokes onClose", () => {
    const { view, onConfirm, onClose } = renderDialog();
    fireEvent.click(view.getByLabelText("Confirm: Disable"));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.click(view.getByLabelText("Cancel destructive action"));
    expect(onClose).toHaveBeenCalled();
  });

  test("backdrop click invokes onClose", () => {
    const { view, onClose } = renderDialog();
    fireEvent.click(view.getByLabelText("Close confirmation"));
    expect(onClose).toHaveBeenCalled();
  });
});
