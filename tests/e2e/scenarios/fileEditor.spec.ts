import fs from "fs";
import path from "path";
import { electronTest as test, electronExpect as expect } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test("text file editor can edit and save files", async ({ page, ui, workspace }) => {
  const fileName = "editor-save-test.txt";
  const filePath = path.join(workspace.demoProject.workspacePath, fileName);
  const initialContent = "First line\nSecond line\n";
  const updatedContent = "First line\nSecond line\nAdded line\n";
  fs.writeFileSync(filePath, initialContent);

  await ui.projects.openFirstWorkspace();
  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.selectTab("Explorer");

  const fileButton = page.getByRole("button", { name: fileName });
  await expect(fileButton).toBeVisible();
  await fileButton.click();

  const viewer = page.getByTestId("text-file-viewer");
  await expect(viewer).toBeVisible();

  const content = viewer.locator(".cm-content");
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(updatedContent, { delay: 10 });

  await expect(viewer.getByText("Unsaved")).toBeVisible();

  await page.keyboard.press("Control+S");

  await expect(viewer.getByText("Unsaved")).toBeHidden({ timeout: 5000 });

  let savedContent = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    savedContent = fs.readFileSync(filePath, "utf-8");
    if (savedContent.includes("Added line")) {
      break;
    }
    await page.waitForTimeout(200);
  }

  expect(savedContent).toBe(updatedContent);
});
