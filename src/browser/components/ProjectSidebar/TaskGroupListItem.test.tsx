import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import * as RealPositionedMenuModule from "../PositionedMenu/PositionedMenu";
import type { TaskGroupListItem as TaskGroupListItemComponent } from "./TaskGroupListItem";

// Radix portal content is unreliable in happy-dom (see AGENTS.md), so render
// the menu inline. The row's shortcut handling under test only needs menu-item
// events to bubble through the React tree, which the inline stub preserves.
void mock.module("@/browser/components/PositionedMenu/PositionedMenu", () => ({
  PositionedMenu: (props: { open: boolean; children: React.ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  PositionedMenuItem: (props: {
    label: string;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  }) => (
    <button type="button" onClick={props.onClick}>
      {props.label}
    </button>
  ),
}));
restoreModulesAfterSuite([
  ["@/browser/components/PositionedMenu/PositionedMenu", { ...RealPositionedMenuModule }],
]);

/* eslint-disable @typescript-eslint/no-require-imports */
const { TaskGroupListItem } = require("./TaskGroupListItem") as {
  TaskGroupListItem: typeof TaskGroupListItemComponent;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function renderTaskGroup(overrides: Partial<React.ComponentProps<typeof TaskGroupListItem>> = {}) {
  return render(
    <TaskGroupListItem
      groupId="best-of-demo"
      title="Compare options"
      kind="bestOf"
      depth={1}
      totalCount={3}
      visibleCount={3}
      completedCount={0}
      runningCount={0}
      queuedCount={0}
      interruptedCount={0}
      isExpanded={false}
      isSelected={false}
      onToggle={() => undefined}
      {...overrides}
    />
  );
}

describe("TaskGroupListItem", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("marks groups with running members as in progress", () => {
    const view = renderTaskGroup({ runningCount: 2, queuedCount: 1 });

    const groupRow = view.getByTestId("task-group-best-of-demo");

    expect(groupRow.dataset.running).toBe("true");
    const descriptionId = groupRow.getAttribute("aria-describedby");
    expect(descriptionId).toBe("task-group-status-best-of-demo");
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain("2 running");
    expect(view.getByTestId("task-group-status-icon").className).toContain("text-content-success");
    expect(groupRow.textContent).toContain("2 running");
  });

  test("keeps queued-only groups pending instead of active", () => {
    const view = renderTaskGroup({ queuedCount: 1 });

    const groupRow = view.getByTestId("task-group-best-of-demo");

    expect(groupRow.dataset.running).toBe("false");
    expect(view.getByTestId("task-group-status-icon").className).not.toContain(
      "text-content-success"
    );
    expect(groupRow.textContent).toContain("1 queued");
  });

  test("handles menu shortcuts without toggling the group or reaching window handlers", () => {
    const onWindowKeydown = mock(() => undefined);
    const onArchiveAll = mock(() => Promise.resolve());
    const onToggle = mock(() => undefined);
    window.addEventListener("keydown", onWindowKeydown);
    const view = renderTaskGroup({ kind: "variants", onArchiveAll, onToggle });
    fireEvent.contextMenu(view.getByTestId("task-group-best-of-demo"));
    const menuItem = view.getByRole("button", { name: /Archive all variants/ });

    fireEvent.keyDown(menuItem, { key: "Enter" });
    expect(onToggle).not.toHaveBeenCalled();
    onWindowKeydown.mockClear();

    fireEvent.keyDown(menuItem, {
      key: "Backspace",
      ctrlKey: true,
      shiftKey: true,
    });
    window.removeEventListener("keydown", onWindowKeydown);

    expect(onArchiveAll).toHaveBeenCalledTimes(1);
    expect(onWindowKeydown).not.toHaveBeenCalled();
  });

  test("handles the archive shortcut without triggering native window handlers", () => {
    const onWindowKeydown = mock(() => undefined);
    const onArchiveAll = mock(() => Promise.resolve());
    window.addEventListener("keydown", onWindowKeydown);
    const view = renderTaskGroup({ kind: "variants", onArchiveAll });

    fireEvent.keyDown(view.getByTestId("task-group-best-of-demo"), {
      key: "Backspace",
      ctrlKey: true,
      shiftKey: true,
    });
    window.removeEventListener("keydown", onWindowKeydown);

    expect(onArchiveAll).toHaveBeenCalledTimes(1);
    expect(onWindowKeydown).not.toHaveBeenCalled();
  });

  test("aggregates member state into the shared status-dot language", () => {
    // Running wins over interrupted: the group is still making progress.
    const running = renderTaskGroup({ runningCount: 1, interruptedCount: 1 });
    expect(running.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("active");
    cleanup();

    const interrupted = renderTaskGroup({ interruptedCount: 1, completedCount: 2 });
    expect(interrupted.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("error");
    cleanup();

    const completed = renderTaskGroup({ completedCount: 3 });
    expect(completed.getByTestId("task-group-best-of-demo").dataset.aggregateState).toBe("idle");
  });
});
