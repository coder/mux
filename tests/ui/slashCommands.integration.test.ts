/**
 * UI smoke test for custom executable slash commands (.mux/commands/*).
 *
 * This test uses the mock AI router (via createAppHarness) to avoid calling real LLMs.
 * It validates the end-to-end UI flow:
 * - User sends `/<name>`
 * - mux discovers and runs `.mux/commands/<name>` in the workspace
 * - stdout becomes the user message sent to the model
 */

import * as fs from "fs/promises";
import * as path from "path";

import { preloadTestModules } from "../ipc/setup";

import { createAppHarness } from "./harness";

async function createCustomCommand(options: {
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

  test("runs a custom command and sends stdout as the message", async () => {
    const app = await createAppHarness({ branchPrefix: "slash-ui" });

    try {
      await createCustomCommand({
        workspacePath: app.metadata.namedWorkspacePath,
        name: "hello",
        script: '#!/usr/bin/env bash\necho "Hello from custom command"',
      });

      await app.chat.send("/hello");

      // The command output should become the user message sent to the model.
      await app.chat.expectTranscriptContains("Mock response: Hello from custom command");
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
