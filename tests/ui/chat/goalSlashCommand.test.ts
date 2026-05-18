import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";

describe("Goal slash command", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("sets a new goal from a completed goal when Enter follows a stale /goal suggestion", async () => {
    const app = await createAppHarness({
      branchPrefix: "goal-slash",
      beforeRender: () => {
        localStorage.setItem(getExperimentKey(EXPERIMENT_IDS.GOALS), JSON.stringify(true));
      },
    });

    try {
      const created = await app.env.orpc.workspace.setGoal({
        workspaceId: app.workspaceId,
        objective: "old completed goal",
        budgetCents: null,
      });
      expect(created.success).toBe(true);
      const completed = await app.env.orpc.workspace.setGoal({
        workspaceId: app.workspaceId,
        status: "complete",
        completionSummary: "Done.",
      });
      expect(completed.success).toBe(true);

      await app.chat.typeWithoutSending("/goal");
      await waitFor(() => {
        const suggestions = app.view.container.querySelector("[data-command-suggestions]");
        expect(suggestions).not.toBeNull();
      });

      await app.chat.typeWithoutSending("/goal this is your new goal,");
      const textarea = app.view.container.querySelector(
        'textarea[aria-label="Message Claude"]'
      ) as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      fireEvent.keyDown(textarea!, { key: "Enter" });

      await waitFor(async () => {
        const { goal } = await app.env.orpc.workspace.getGoal({ workspaceId: app.workspaceId });
        expect(goal?.objective).toBe("this is your new goal,");
        expect(goal?.status).toBe("active");
      });
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
