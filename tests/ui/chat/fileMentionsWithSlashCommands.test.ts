import "../dom";
import { waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

describe("File mentions with slash commands", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("/sonnet @ shows file path suggestions", async () => {
    const app = await createAppHarness({ branchPrefix: "file-mention-slash" });

    try {
      await app.chat.typeWithoutSending("/sonnet @");

      await waitFor(
        () => {
          const listbox = app.view.container.querySelector(
            '[role="listbox"][aria-label="File path suggestions"]'
          );

          if (!listbox) {
            throw new Error("File path suggestion listbox not found");
          }

          const options = listbox.querySelectorAll('[role="option"]');
          if (options.length === 0) {
            throw new Error("No file suggestions shown");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
