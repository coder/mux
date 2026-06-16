import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./Dialog";

let cleanupDom: (() => void) | null = null;

function DialogInsideClickableContainer(props: {
  onContainerClick: () => void;
  onContainerPointerDown: () => void;
  onContainerTouchStart: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div
      onClick={() => {
        props.onContainerClick();
        setOpen(false);
      }}
      onPointerDown={props.onContainerPointerDown}
      onTouchStart={props.onContainerTouchStart}
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Portal dialog</DialogTitle>
          </DialogHeader>
          <DialogDescription>Regression harness for portal event bubbling.</DialogDescription>
          <button type="button">Inside action</button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

describe("Dialog", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps content interactions from bubbling to clickable React ancestors", () => {
    const onContainerClick = mock(() => undefined);
    const onContainerPointerDown = mock(() => undefined);
    const onContainerTouchStart = mock(() => undefined);
    const view = render(
      <DialogInsideClickableContainer
        onContainerClick={onContainerClick}
        onContainerPointerDown={onContainerPointerDown}
        onContainerTouchStart={onContainerTouchStart}
      />
    );
    const button = view.getByRole("button", { name: "Inside action" });

    fireEvent.pointerDown(button);
    fireEvent.touchStart(button);
    fireEvent.click(button);

    expect(onContainerPointerDown).not.toHaveBeenCalled();
    expect(onContainerTouchStart).not.toHaveBeenCalled();
    expect(onContainerClick).not.toHaveBeenCalled();
    expect(view.getByText("Portal dialog")).toBeTruthy();
  });
});
