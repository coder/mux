import { electronTest as test } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test("terminal tab opens without error", async ({ ui }) => {
  await ui.projects.openFirstWorkspace();

  // Navigate to the Terminal tab in the right sidebar
  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.selectTab("Terminal");

  // Verify the terminal opens without the "isOpen" error
  await ui.metaSidebar.expectTerminalNoError();
});

test("terminal tab handles workspace switching", async ({ ui, page }) => {
  await ui.projects.openFirstWorkspace();

  // Open Terminal tab
  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.selectTab("Terminal");
  await ui.metaSidebar.expectTerminalNoError();

  // Switch to Costs tab (unmounts terminal UI but keeps session alive)
  await ui.metaSidebar.selectTab("Costs");

  // Switch back to Terminal tab (should reattach to existing session)
  await ui.metaSidebar.selectTab("Terminal");
  await ui.metaSidebar.expectTerminalNoError();
});
