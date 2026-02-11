import "./dom";
import { describe, test, expect, beforeEach } from "bun:test";
import {
  findAdjacentWorkspaceId,
  getVisibleWorkspaceIds,
} from "@/browser/utils/ui/workspaceDomNav";

/** Create a fake workspace row element in the DOM. */
function addWorkspaceRow(id: string, path: string = `/repo/${id}`): void {
  const el = document.createElement("div");
  el.setAttribute("data-workspace-id", id);
  el.setAttribute("data-workspace-path", path);
  document.body.appendChild(el);
}

describe("getVisibleWorkspaceIds", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("returns empty array when no workspace rows exist", () => {
    expect(getVisibleWorkspaceIds()).toEqual([]);
  });

  test("returns IDs in DOM order", () => {
    addWorkspaceRow("ws-a");
    addWorkspaceRow("ws-b");
    addWorkspaceRow("ws-c");
    expect(getVisibleWorkspaceIds()).toEqual(["ws-a", "ws-b", "ws-c"]);
  });

  test("ignores elements that only have data-workspace-id (e.g. archive buttons)", () => {
    addWorkspaceRow("ws-a");
    const partial = document.createElement("button");
    partial.setAttribute("data-workspace-id", "ws-a");
    // Missing data-workspace-path → should not be picked up
    document.body.appendChild(partial);
    expect(getVisibleWorkspaceIds()).toEqual(["ws-a"]);
  });
});

describe("findAdjacentWorkspaceId", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("returns next workspace when one exists after the current", () => {
    addWorkspaceRow("ws-a");
    addWorkspaceRow("ws-b");
    addWorkspaceRow("ws-c");
    expect(findAdjacentWorkspaceId("ws-a")).toBe("ws-b");
    expect(findAdjacentWorkspaceId("ws-b")).toBe("ws-c");
  });

  test("returns previous workspace when current is last", () => {
    addWorkspaceRow("ws-a");
    addWorkspaceRow("ws-b");
    expect(findAdjacentWorkspaceId("ws-b")).toBe("ws-a");
  });

  test("returns null when current is the only workspace", () => {
    addWorkspaceRow("ws-a");
    expect(findAdjacentWorkspaceId("ws-a")).toBeNull();
  });

  test("returns first visible workspace when current is not in the DOM (collapsed project)", () => {
    addWorkspaceRow("ws-a");
    addWorkspaceRow("ws-b");
    // "ws-hidden" is the active workspace but its project is collapsed
    expect(findAdjacentWorkspaceId("ws-hidden")).toBe("ws-a");
  });

  test("returns null when DOM is empty (no visible workspaces at all)", () => {
    expect(findAdjacentWorkspaceId("ws-a")).toBeNull();
  });
});
