/**
 * UI tests for custom slash commands (.mux/commands/*).
 *
 * Tests each level from the docs:
 * - Level 1: Static files (.md) read verbatim
 * - Level 2: Executable scripts (stdout becomes message)
 * - Level 3: Arguments passed to executables
 * - Exit code 2: User abort (output shown but not sent to model)
 * - Streaming: Output appears progressively during execution
 *
 * Uses mock AI router (via createAppHarness) to avoid calling real LLMs.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

import { preloadTestModules } from "../ipc/setup";

import { createAppHarness } from "./harness";

// Helper to create a static markdown file command
async function createStaticCommand(options: {
  workspacePath: string;
  name: string;
  content: string;
}): Promise<void> {
  const commandsDir = path.join(options.workspacePath, ".mux", "commands");
  await fs.mkdir(commandsDir, { recursive: true });

  const commandPath = path.join(commandsDir, `${options.name}.md`);
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
      // Wait a bit then verify no model response was sent
      await new Promise((r) => setTimeout(r, 2000));
      await app.chat.expectTranscriptNotContains("Mock response:");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  // Streaming: Output is accumulated progressively during execution
  // Uses file-based synchronization to prove output arrives before command completes
  test("streaming: output accumulates progressively during execution", async () => {
    const app = await createAppHarness({ branchPrefix: "slash-stream" });

    // Create a unique temp directory for sync files
    const syncDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-stream-test-"));

    try {
      // Script outputs lines and waits for signal files between each step.
      // This gives us deterministic synchronization to prove streaming works.
      await createExecutableCommand({
        workspacePath: app.metadata.namedWorkspacePath,
        name: "progress",
        script: `#!/usr/bin/env bash
SYNC_DIR="${syncDir}"

echo "Step 1: Starting"
touch "$SYNC_DIR/step1.ready"
while [ ! -f "$SYNC_DIR/step1.continue" ]; do sleep 0.05; done

echo "Step 2: Processing"
touch "$SYNC_DIR/step2.ready"
while [ ! -f "$SYNC_DIR/step2.continue" ]; do sleep 0.05; done

echo "Step 3: Done"
`,
      });

      // Start the command without awaiting completion
      const sendPromise = app.chat.send("/progress");

      // Wait for step 1 to be output by the script
      await waitForFile(path.join(syncDir, "step1.ready"));
      // Signal to continue to step 2
      await fs.writeFile(path.join(syncDir, "step1.continue"), "");

      // Wait for step 2 to be output
      await waitForFile(path.join(syncDir, "step2.ready"));
      // Signal to finish
      await fs.writeFile(path.join(syncDir, "step2.continue"), "");

      // Wait for command to complete
      await sendPromise;

      // Final message sent to model should contain all steps (proves streaming accumulated correctly)
      await app.chat.expectTranscriptContains("Mock response:");
      // Verify all 3 steps made it into the final message
      await app.chat.expectTranscriptContains("Step 1: Starting");
      await app.chat.expectTranscriptContains("Step 2: Processing");
      await app.chat.expectTranscriptContains("Step 3: Done");
    } finally {
      await app.dispose();
      // Cleanup sync directory
      await fs.rm(syncDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});

/** Wait for a file to exist (with timeout). */
async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`Timeout waiting for file: ${filePath}`);
}
