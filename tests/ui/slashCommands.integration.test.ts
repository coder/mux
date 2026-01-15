/**
 * UI tests for custom slash commands (.mux/commands/*).
 *
 * Tests each level from the docs:
 * - Level 1: Static files (.txt/.md) read verbatim
 * - Level 2: Executable scripts (stdout becomes message)
 * - Level 3: Arguments passed to executables
 * - Exit code 2: User abort (output shown but not sent to model)
 *
 * Uses mock AI router (via createAppHarness) to avoid calling real LLMs.
 */

import * as fs from "fs/promises";
import * as path from "path";

import { preloadTestModules } from "../ipc/setup";

import { createAppHarness } from "./harness";

// Helper to create a static text file command
async function createStaticCommand(options: {
  workspacePath: string;
  name: string;
  content: string;
}): Promise<void> {
  const commandsDir = path.join(options.workspacePath, ".mux", "commands");
  await fs.mkdir(commandsDir, { recursive: true });

  const commandPath = path.join(commandsDir, `${options.name}.txt`);
  await fs.writeFile(commandPath, options.content);
}

// Helper to create an executable command
async function createExecutableCommand(options: {
  workspacePath: string;
  name: string;
  script: string;
}): Promise<void> {
  const commandsDir = path.join(options.workspacePath, ".mux", "commands");
  await fs.mkdir(commandsDir, { recursive: true });

  const commandPath = path.join(commandsDir, options.name);
  await fs.writeFile(commandPath, options.script);
  await fs.chmod(commandPath, 0o755);
}

describe("Custom Slash Commands UI (mock router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  // Level 1: Static file - contents read verbatim
  test("Level 1: static .txt file contents become the message", async () => {
    const app = await createAppHarness({ branchPrefix: "slash-l1" });

    try {
      await createStaticCommand({
        workspacePath: app.metadata.namedWorkspacePath,
        name: "dry",
        content: "Refactor to follow DRY principles",
      });

      await app.chat.send("/dry");

      await app.chat.expectTranscriptContains("Mock response: Refactor to follow DRY principles");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  // Level 2: Executable script - stdout becomes message
  test("Level 2: executable script stdout becomes the message", async () => {
    const app = await createAppHarness({ branchPrefix: "slash-l2" });

    try {
      await createExecutableCommand({
        workspacePath: app.metadata.namedWorkspacePath,
        name: "context",
        script: `#!/usr/bin/env bash
echo "Current directory: $(pwd)"`,
      });

      await app.chat.send("/context");

      await app.chat.expectTranscriptContains("Mock response: Current directory:");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  // Level 3: Arguments - passed to executable
  test("Level 3: arguments are passed to executable", async () => {
    const app = await createAppHarness({ branchPrefix: "slash-l3" });

    try {
      await createExecutableCommand({
        workspacePath: app.metadata.namedWorkspacePath,
        name: "greet",
        script: `#!/usr/bin/env bash
echo "Hello, $1!"`,
      });

      await app.chat.send("/greet World");

      await app.chat.expectTranscriptContains("Mock response: Hello, World!");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  // Exit code 2: User abort - output shown but NOT sent to model
  test("exit code 2 aborts without sending to model", async () => {
    const app = await createAppHarness({ branchPrefix: "slash-abort" });

    try {
      await createExecutableCommand({
        workspacePath: app.metadata.namedWorkspacePath,
        name: "preview",
        script: `#!/usr/bin/env bash
echo "Preview output"
exit 2`,
      });

      await app.chat.send("/preview");

      // Should NOT see a model response (exit 2 = user abort)
      // Instead, the input should be restored for editing
      await app.chat.expectTranscriptNotContains("Mock response:");

      // The original command should be restored in the input
      await app.chat.expectInputContains("/preview");
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
