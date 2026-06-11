import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import { findAdjacentWorkspaceId, getVisibleWorkspaceIds } from "./workspaceDomNav";

function appendWorkspaceRow(workspaceId: string): void {
  const row = document.createElement("div");
  row.setAttribute("data-workspace-id", workspaceId);
  row.setAttribute("data-workspace-path", `/tmp/${workspaceId}`);
  document.body.appendChild(row);
}

function renderWorkspaceRows(workspaceIds: string[]): void {
  document.body.innerHTML = "";
  workspaceIds.forEach(appendWorkspaceRow);
}

describe("workspaceDomNav", () => {
  beforeEach(() => {
    const happyWindow = new GlobalWindow();
    globalThis.window = happyWindow as unknown as Window & typeof globalThis;
    globalThis.document = happyWindow.document as unknown as Document;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = happyWindow.HTMLElement;
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement = undefined;
  });

  test("returns visible workspace IDs in DOM order", () => {
    renderWorkspaceRows(["alpha", "beta", "gamma"]);

    expect(getVisibleWorkspaceIds()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("prefers the workspace above in the same project when archiving", () => {
    renderWorkspaceRows(["same-above", "same-current", "other-below"]);

    const projectByWorkspaceId: Record<string, string> = {
      "same-above": "/projects/same",
      "same-current": "/projects/same",
      "other-below": "/projects/other",
    };

    expect(
      findAdjacentWorkspaceId("same-current", {
        preferredProjectPath: "/projects/same",
        getProjectPath: (workspaceId) => projectByWorkspaceId[workspaceId],
      })
    ).toBe("same-above");
  });

  test("prefers the workspace below in the same project before leaving the project", () => {
    renderWorkspaceRows(["other-above", "same-current", "same-below"]);

    const projectByWorkspaceId: Record<string, string> = {
      "other-above": "/projects/other",
      "same-current": "/projects/same",
      "same-below": "/projects/same",
    };

    expect(
      findAdjacentWorkspaceId("same-current", {
        preferredProjectPath: "/projects/same",
        getProjectPath: (workspaceId) => projectByWorkspaceId[workspaceId],
      })
    ).toBe("same-below");
  });

  test("falls back to the workspace above when no same-project chat remains", () => {
    renderWorkspaceRows(["other-above", "same-current", "other-below"]);

    const projectByWorkspaceId: Record<string, string> = {
      "other-above": "/projects/other",
      "same-current": "/projects/same",
      "other-below": "/projects/other-2",
    };

    expect(
      findAdjacentWorkspaceId("same-current", {
        preferredProjectPath: "/projects/same",
        getProjectPath: (workspaceId) => projectByWorkspaceId[workspaceId],
      })
    ).toBe("other-above");
  });

  test("prefers a visible same-project chat when the current row is not rendered", () => {
    renderWorkspaceRows(["other-above", "same-below"]);

    const projectByWorkspaceId: Record<string, string> = {
      "same-current": "/projects/same",
      "other-above": "/projects/other",
      "same-below": "/projects/same",
    };

    expect(
      findAdjacentWorkspaceId("same-current", {
        preferredProjectPath: "/projects/same",
        getProjectPath: (workspaceId) => projectByWorkspaceId[workspaceId],
      })
    ).toBe("same-below");
  });
});
