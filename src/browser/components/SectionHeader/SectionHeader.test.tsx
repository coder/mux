import "../../../../tests/ui/dom";

import type { ComponentProps } from "react";
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { SectionConfig } from "@/common/types/project";
import { TooltipProvider } from "../Tooltip/Tooltip";

import { SectionHeader } from "./SectionHeader";

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
    onAutoCreateAbandon,
    onAutoCreateRenameCancel,
  };
}

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
