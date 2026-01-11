/**
 * Integration tests for custom slash commands (.mux/commands/*).
 *
 * Tests the backend functionality:
 * - Command discovery (list)
 * - Command execution (run)
 * - Exit code handling
 * - Argument and stdin passing
 */

import * as fs from "fs/promises";
import * as path from "path";

import { shouldRunIntegrationTests } from "../testUtils";
import { cleanupSharedRepo, createSharedRepo, withSharedWorkspace } from "./sendMessageTestHelpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Helper to create a custom slash command in the workspace
async function createCustomCommand(
  workspacePath: string,
  name: string,
  script: string
): Promise<void> {
  const commandsDir = path.join(workspacePath, ".mux", "commands");
  await fs.mkdir(commandsDir, { recursive: true });
  const commandPath = path.join(commandsDir, name);
  await fs.writeFile(commandPath, script);
  await fs.chmod(commandPath, 0o755);
}

describeIntegration("Custom Slash Commands (Backend)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("listSlashCommands discovers commands in .mux/commands", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create a custom command
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "test-cmd",
        '#!/bin/bash\necho "Test output"'
      );

      // List commands via API
      const commands = await env.orpc.workspace.slashCommands.list({ workspaceId });

      expect(commands).toContainEqual({ name: "test-cmd" });
    });
  }, 30_000);

  test("listSlashCommands filters invalid command names", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create valid and invalid commands
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "valid-cmd",
        '#!/bin/bash\necho "valid"'
      );
      // Invalid name (has underscore - not allowed)
      const commandsDir = path.join(metadata.namedWorkspacePath, ".mux", "commands");
      await fs.writeFile(path.join(commandsDir, "invalid_cmd"), '#!/bin/bash\necho "invalid"');
      await fs.chmod(path.join(commandsDir, "invalid_cmd"), 0o755);

      const commands = await env.orpc.workspace.slashCommands.list({ workspaceId });

      expect(commands).toContainEqual({ name: "valid-cmd" });
      // Invalid command should not be listed
      expect(commands.map((c) => c.name)).not.toContain("invalid_cmd");
    });
  }, 30_000);

  test("runSlashCommand executes and returns stdout", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "echo-test",
        '#!/bin/bash\necho "Hello from custom command"'
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "echo-test",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout).toBe("Hello from custom command");
        expect(result.data.exitCode).toBe(0);
      }
    });
  }, 30_000);

  test("runSlashCommand passes arguments correctly", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "args-test",
        '#!/bin/bash\necho "Args: $@"'
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "args-test",
        args: ["foo", "bar", "baz"],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout).toBe("Args: foo bar baz");
      }
    });
  }, 30_000);

  test("runSlashCommand passes stdin correctly", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "stdin-test",
        '#!/bin/bash\necho "Got stdin:"\ncat'
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "stdin-test",
        stdin: "Hello from stdin\nLine 2",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout).toContain("Got stdin:");
        expect(result.data.stdout).toContain("Hello from stdin");
        expect(result.data.stdout).toContain("Line 2");
      }
    });
  }, 30_000);

  test("runSlashCommand handles exit code 0 as success", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "success-test",
        '#!/bin/bash\necho "Success"\nexit 0'
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "success-test",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.exitCode).toBe(0);
        expect(result.data.stdout).toBe("Success");
      }
    });
  }, 30_000);

  test("runSlashCommand handles exit code 2 specially (user abort)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "abort-test",
        '#!/bin/bash\necho "Aborted by user"\nexit 2'
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "abort-test",
      });

      // Exit code 2 should still return success (with the output)
      // The frontend handles exit code 2 specially to not send to model
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.exitCode).toBe(2);
        expect(result.data.stdout).toBe("Aborted by user");
      }
    });
  }, 30_000);

  test("runSlashCommand returns error for non-zero exit (except 2)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createCustomCommand(
        metadata.namedWorkspacePath,
        "fail-test",
        '#!/bin/bash\necho "Error output" >&2\nexit 1'
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "fail-test",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("exit code 1");
      }
    });
  }, 30_000);

  test("runSlashCommand returns error for invalid command name", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId }) => {
      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "nonexistent",
      });

      expect(result.success).toBe(false);
    });
  }, 30_000);
});
