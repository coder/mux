import "./dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules } from "../ipc/setup";
import { ChatHarness, createAppHarness } from "./harness";

function getWorkspaceNameFromSidebarElement(element: HTMLElement): string {
  const workspacePath = element.getAttribute("data-workspace-path") ?? "";
  return workspacePath.split(/[/\\]/).pop() ?? "";
}

async function waitForSelectedWorkspaceElement(
  container: HTMLElement,
  predicate: (element: HTMLElement) => boolean
): Promise<HTMLElement> {
  return waitFor(
    () => {
      const element = container.querySelector(
        '[data-workspace-id][aria-current="true"]'
      ) as HTMLElement | null;

      if (!element) {
        throw new Error("Selected workspace element not found");
      }

      if (!predicate(element)) {
        throw new Error("Selected workspace element did not match predicate");
      }

      return element;
    },
    { timeout: 30_000 }
  );
}

describe("Workspace fork (UI)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("/fork without a name creates a new workspace and switches to it (incrementing suffix)", async () => {
    const app = await createAppHarness({ branchPrefix: "fork-ui" });
    const forkedWorkspaceIds: string[] = [];

    try {
      // Sanity check: we start on the source workspace.
      await waitForSelectedWorkspaceElement(app.view.container, (el) => {
        return el.getAttribute("data-workspace-id") === app.workspaceId;
      });

      const sourceName = app.metadata.name;

      // 1) First fork should produce <source>-fork
      await app.chat.send("/fork");

      const firstForkElement = await waitForSelectedWorkspaceElement(app.view.container, (el) => {
        const id = el.getAttribute("data-workspace-id");
        return Boolean(id && id !== app.workspaceId);
      });

      const firstForkId = firstForkElement.getAttribute("data-workspace-id");
      if (!firstForkId) {
        throw new Error("First fork workspace ID missing");
      }
      forkedWorkspaceIds.push(firstForkId);

      expect(getWorkspaceNameFromSidebarElement(firstForkElement)).toBe(`${sourceName}-fork`);
      expect(firstForkElement.textContent ?? "").toContain(`${sourceName} (fork)`);

      // 2) Forking the fork should produce <source>-fork-2 (still based on the original)
      const forkChat = new ChatHarness(app.view.container, firstForkId);
      await forkChat.send("/fork");

      const secondForkElement = await waitForSelectedWorkspaceElement(app.view.container, (el) => {
        const id = el.getAttribute("data-workspace-id");
        return Boolean(id && id !== app.workspaceId && id !== firstForkId);
      });

      const secondForkId = secondForkElement.getAttribute("data-workspace-id");
      if (!secondForkId) {
        throw new Error("Second fork workspace ID missing");
      }
      forkedWorkspaceIds.push(secondForkId);

      expect(getWorkspaceNameFromSidebarElement(secondForkElement)).toBe(`${sourceName}-fork-2`);
      expect(secondForkElement.textContent ?? "").toContain(`${sourceName} (fork 2)`);
    } finally {
      // Best-effort cleanup: createAppHarness() only removes the initial workspace.
      for (const workspaceId of forkedWorkspaceIds) {
        try {
          await app.env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort.
        }
      }

      await app.dispose();
    }
  }, 60_000);

  test("Fork button on assistant messages forks the current workspace", async () => {
    const app = await createAppHarness({ branchPrefix: "fork-button" });
    const forkedWorkspaceIds: string[] = [];

    try {
      const sourceName = app.metadata.name;

      await app.chat.send("Hello from the fork button test");
      await app.chat.expectTranscriptContains(
        "Mock response: Hello from the fork button test",
        30_000
      );

      const forkButton = await waitFor(
        () => {
          const button = app.view.container.querySelector(
            'button[aria-label="Fork"]'
          ) as HTMLButtonElement | null;

          if (!button) {
            throw new Error("Fork button not found");
          }

          if (button.disabled) {
            throw new Error("Fork button is disabled");
          }

          return button;
        },
        { timeout: 30_000 }
      );

      fireEvent.click(forkButton);

      const forkElement = await waitForSelectedWorkspaceElement(app.view.container, (el) => {
        const id = el.getAttribute("data-workspace-id");
        return Boolean(id && id !== app.workspaceId);
      });

      const forkId = forkElement.getAttribute("data-workspace-id");
      if (!forkId) {
        throw new Error("Forked workspace ID missing");
      }
      forkedWorkspaceIds.push(forkId);

      expect(getWorkspaceNameFromSidebarElement(forkElement)).toBe(`${sourceName}-fork`);
      expect(forkElement.textContent ?? "").toContain(`${sourceName} (fork)`);
    } finally {
      for (const workspaceId of forkedWorkspaceIds) {
        try {
          await app.env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort.
        }
      }

      await app.dispose();
    }
  }, 60_000);
});
