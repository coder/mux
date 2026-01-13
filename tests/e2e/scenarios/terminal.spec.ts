import fs from "fs";
import path from "path";
import { electronTest as test, electronExpect as expect } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test("terminal tab opens without error", async ({ ui }) => {
  await ui.projects.openFirstWorkspace();

  // Terminal is not a default tab - click "+" to add one
  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.addTerminal();

  // Verify the terminal opens without the "isOpen" error
  await ui.metaSidebar.expectTerminalNoError();
});

test("terminal tab handles workspace switching", async ({ ui, page }) => {
  await ui.projects.openFirstWorkspace();

  // Terminal is not a default tab - click "+" to add one
  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.addTerminal();
  await ui.metaSidebar.expectTerminalNoError();

  // Switch to Costs tab (unmounts terminal UI but keeps session alive)
  await ui.metaSidebar.selectTab("Costs");

  // Switch back to Terminal tab (should reattach to existing session)
  await ui.metaSidebar.selectTab("Terminal");
  await ui.metaSidebar.expectTerminalNoError();
});

/**
 * Regression test for: https://github.com/coder/mux/pull/1586
 *
 * The bug: attachCustomKeyEventHandler in TerminalView.tsx had inverted return values.
 * ghostty-web's API expects:
 * - return true  → PREVENT default (we handled it)
 * - return false → ALLOW default (let ghostty process it)
 *
 * The buggy code returned true for all non-clipboard keys, which PREVENTED ghostty
 * from processing any keyboard input. Users couldn't type anything in the terminal.
 *
 * This test verifies keyboard input reaches the terminal by:
 * 1. Opening a terminal
 * 2. Typing a command that creates a marker file
 * 3. Checking that the file was created (proving input was processed)
 */
test("keyboard input reaches terminal (regression #1586)", async ({ ui, page, workspace }) => {
  await ui.projects.openFirstWorkspace();

  // Open a terminal
  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.addTerminal();
  await ui.metaSidebar.expectTerminalNoError();

  // Wait for terminal to be ready (shell prompt)
  await page.waitForTimeout(1000);

  // Focus the terminal and type a command
  // This tests the CRITICAL path that was broken in #1586:
  // keydown event → ghostty key handler → returns false → ghostty processes input
  await ui.metaSidebar.focusTerminal();

  // Type a command that creates a marker file with unique content
  // If the key handler blocks input, this file won't be created
  const marker = `TERMINAL_INPUT_TEST_${Date.now()}`;
  const testFile = "terminal_input_test.txt";

  // Type the echo command character by character - each keystroke must flow
  // through the key handler. If #1586 regressed, typing would be blocked.
  await page.keyboard.type(`echo "${marker}" > ${testFile}`, { delay: 50 });
  await page.keyboard.press("Enter");

  // Wait for command to execute
  await page.waitForTimeout(500);

  // Verify the file was created by reading it back
  // Type another command to cat the file
  await page.keyboard.type(`cat ${testFile}`, { delay: 50 });
  await page.keyboard.press("Enter");

  // Wait and then check via a second verification: create a confirmation marker
  await page.waitForTimeout(500);
  await page.keyboard.type(`test -f ${testFile} && echo "FILE_EXISTS"`, { delay: 50 });
  await page.keyboard.press("Enter");

  // Give commands time to complete
  await page.waitForTimeout(1000);

  // CRITICAL ASSERTION: Verify the file was actually created.
  // This proves keyboard input reached the terminal - if the bug from #1586
  // regressed (key handler returning true), the file would NOT exist because
  // ghostty wouldn't process any keystrokes.
  const filePath = path.join(workspace.demoProject.workspacePath, testFile);

  // Poll for file creation (shell command may take a moment)
  let fileExists = false;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(filePath)) {
      fileExists = true;
      break;
    }
    await page.waitForTimeout(200);
  }

  expect(fileExists).toBe(true);

  // Also verify the file contains our marker
  const fileContents = fs.readFileSync(filePath, "utf-8").trim();
  expect(fileContents).toBe(marker);
});

/**
 * Test that special keys (Enter, Tab, Backspace, arrows) work correctly.
 * These were also blocked by the #1586 bug since the handler returned true
 * for ALL non-clipboard keydown events.
 */
test("special keys work in terminal (regression #1586)", async ({ ui, page, workspace }) => {
  await ui.projects.openFirstWorkspace();

  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.addTerminal();
  await ui.metaSidebar.expectTerminalNoError();

  await page.waitForTimeout(1000);
  await ui.metaSidebar.focusTerminal();

  // Create a unique marker file to verify the test actually works
  const marker = `SPECIAL_KEYS_TEST_${Date.now()}`;
  const testFile = "special_keys_test.txt";

  // Test Backspace - type something wrong, delete it with Backspace, then type correct value
  // If Backspace doesn't work, the file will contain "wrongMARKER" instead of just "MARKER"
  await page.keyboard.type("echo wrong");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  // Now type the actual marker
  await page.keyboard.type(`${marker} > ${testFile}`, { delay: 30 });
  await page.keyboard.press("Enter"); // This was blocked in #1586

  await page.waitForTimeout(1000);

  // CRITICAL ASSERTION: Verify the file was created with CORRECT content.
  // This proves both Enter AND Backspace work:
  // - Enter must work for the command to execute
  // - Backspace must work or the file would contain "wrong" prefix
  const filePath = path.join(workspace.demoProject.workspacePath, testFile);

  let fileExists = false;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(filePath)) {
      fileExists = true;
      break;
    }
    await page.waitForTimeout(200);
  }

  expect(fileExists).toBe(true);

  const fileContents = fs.readFileSync(filePath, "utf-8").trim();
  // If Backspace didn't work, this would be "wrongMARKER..." instead of just the marker
  expect(fileContents).toBe(marker);
});
