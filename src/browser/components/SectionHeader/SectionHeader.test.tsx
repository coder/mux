import "../../../../tests/ui/dom";

import React, { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { SectionConfig } from "@/common/types/project";
import { TooltipProvider } from "../Tooltip/Tooltip";
import type { SectionHeader as SectionHeaderComponent } from "./SectionHeader";

let SectionHeader!: typeof SectionHeaderComponent;

const baseSection: SectionConfig = {
  id: "section-1",
  name: "New sub-folder",
  color: "#6B7280",
  nextId: null,
};

function renderSectionHeader(overrides: Partial<ComponentProps<typeof SectionHeader>> = {}) {
  const onToggleExpand = mock(() => undefined);
  const onAddWorkspace = mock(() => undefined);
  const onRename = mock((_name: string) => undefined);
  const onChangeColor = mock((_color: string) => undefined);
  const onDelete = mock((_anchorEl: HTMLElement) => undefined);
  const onAutoCreateAbandon = mock(() => undefined);
  const onAutoCreateRenameCancel = mock(() => undefined);

  const view = render(
    <TooltipProvider>
      <SectionHeader
        section={baseSection}
        isExpanded
        workspaceCount={0}
        hasAttention={false}
        onToggleExpand={onToggleExpand}
        onAddWorkspace={onAddWorkspace}
        onRename={onRename}
        onChangeColor={onChangeColor}
        onDelete={onDelete}
        autoStartEditing
        onAutoCreateAbandon={onAutoCreateAbandon}
        onAutoCreateRenameCancel={onAutoCreateRenameCancel}
        {...overrides}
      />
    </TooltipProvider>
  );

  return {
    ...view,
    onRename,
    onDelete,
    onAutoCreateAbandon,
    onAutoCreateRenameCancel,
  };
}

beforeEach(() => {
  void mock.module("../../hooks/useContextMenuPosition", () => ({
    useContextMenuPosition: () => {
      const [isOpen, setIsOpen] = React.useState(false);
      const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);

      return {
        position,
        isOpen,
        onContextMenu: (event: {
          preventDefault?: () => void;
          stopPropagation?: () => void;
          clientX?: number;
          clientY?: number;
        }) => {
          event.preventDefault?.();
          event.stopPropagation?.();
          setPosition({ x: event.clientX ?? 0, y: event.clientY ?? 0 });
          setIsOpen(true);
        },
        onOpenChange: (open: boolean) => {
          setIsOpen(open);
        },
        touchHandlers: {
          onTouchStart: () => undefined,
          onTouchEnd: () => undefined,
          onTouchMove: () => undefined,
        },
        suppressClickIfLongPress: () => false,
        close: () => {
          setIsOpen(false);
        },
      };
    },
  }));
  void mock.module("../PositionedMenu/PositionedMenu", () => ({
    PositionedMenu: (props: { open: boolean; children: React.ReactNode }) =>
      props.open ? <div data-testid="section-actions-menu">{props.children}</div> : null,
    PositionedMenuItem: (props: {
      label: string;
      disabled?: boolean;
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    }) => (
      <button type="button" disabled={props.disabled} onClick={props.onClick}>
        {props.label}
      </button>
    ),
  }));

  /* eslint-disable @typescript-eslint/no-require-imports */
  ({ SectionHeader } = require("./SectionHeader?section-header-test=1") as {
    SectionHeader: typeof SectionHeaderComponent;
  });
  /* eslint-enable @typescript-eslint/no-require-imports */
});

afterEach(() => {
  cleanup();
  mock.restore();
});

describe("SectionHeader auto-created section editing", () => {
  test("starts in edit mode when autoStartEditing is true", async () => {
    const view = renderSectionHeader();

    await waitFor(() => {
      const input = view.getByTestId("section-rename-input") as HTMLInputElement;
      expect(input.value).toBe("New sub-folder");
    });
  });

  test("removes section on Escape when user has not typed", async () => {
    const view = renderSectionHeader();

    const input = (await waitFor(() =>
      view.getByTestId("section-rename-input")
    )) as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });

    expect(view.onAutoCreateAbandon).toHaveBeenCalledTimes(1);
    expect(view.onRename).not.toHaveBeenCalled();
  });

  test("blur without edits exits auto-create mode without deleting", async () => {
    const view = renderSectionHeader();

    const input = (await waitFor(() =>
      view.getByTestId("section-rename-input")
    )) as HTMLInputElement;
    fireEvent.blur(input);

    expect(view.onAutoCreateRenameCancel).toHaveBeenCalledTimes(1);
    expect(view.onAutoCreateAbandon).not.toHaveBeenCalled();
    expect(view.onRename).not.toHaveBeenCalled();
  });

  test("clears auto-create editing on Escape after typing", async () => {
    const view = renderSectionHeader();

    const input = (await waitFor(() =>
      view.getByTestId("section-rename-input")
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Changed name" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(view.onAutoCreateRenameCancel).toHaveBeenCalledTimes(1);
    expect(view.onAutoCreateAbandon).not.toHaveBeenCalled();
    expect(view.onRename).not.toHaveBeenCalled();
  });
});

describe("SectionHeader actions menu", () => {
  test("opens the menu when clicking section actions", () => {
    const view = renderSectionHeader({ autoStartEditing: false });

    expect(view.queryByTestId("section-actions-menu")).toBeNull();

    fireEvent.click(view.getByLabelText("Section actions"));

    expect(view.getByTestId("section-actions-menu")).toBeTruthy();
  });

  test("shows the color picker when selecting Change color", () => {
    const view = renderSectionHeader({ autoStartEditing: false });

    fireEvent.click(view.getByLabelText("Section actions"));
    fireEvent.click(view.getByRole("button", { name: "Change color" }));

    expect(view.container.querySelector(".section-color-picker")).not.toBeNull();
  });

  test("enters edit mode when selecting Rename", async () => {
    const view = renderSectionHeader({ autoStartEditing: false });

    fireEvent.click(view.getByLabelText("Section actions"));
    fireEvent.click(view.getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(view.getByTestId("section-rename-input")).toBeTruthy();
    });
  });

  test("calls onDelete when selecting Delete section", () => {
    const view = renderSectionHeader({ autoStartEditing: false });

    fireEvent.click(view.getByLabelText("Section actions"));

    const deleteButton = view.getByRole("button", { name: "Delete section" });
    fireEvent.click(deleteButton);

    expect(view.onDelete).toHaveBeenCalledTimes(1);
    expect(view.onDelete.mock.calls[0]?.[0]).toBe(deleteButton);
  });
});
