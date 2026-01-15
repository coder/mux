/**
 * Integration tests for custom slash commands (.mux/commands/*).
 *
 * Tests the backend functionality:
 * - Command discovery (list)
 * - Command execution (run)
 * - Exit code handling
 * - Argument passing
 */

import * as fs from "fs/promises";
import * as path from "path";

import { shouldRunIntegrationTests } from "../testUtils";
import { cleanupSharedRepo, createSharedRepo, withSharedWorkspace } from "./sendMessageTestHelpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Helper to create a custom slash command (executable) in the workspace
async function createExecutableCommand(
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

// Helper to create a static text file command
async function createStaticCommand(
  workspacePath: string,
  name: string,
  content: string,
  extension: ".txt" | ".md" = ".txt"
): Promise<void> {
  const commandsDir = path.join(workspacePath, ".mux", "commands");
  await fs.mkdir(commandsDir, { recursive: true });
  const commandPath = path.join(commandsDir, `${name}${extension}`);
  await fs.writeFile(commandPath, content);
}

describeIntegration("Custom Slash Commands (Backend)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("listSlashCommands discovers executable commands", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create an executable command
      await createExecutableCommand(
        metadata.namedWorkspacePath,
        "test-cmd",
        '#!/bin/bash\necho "Test output"'
      );

      // List commands via API
      const commands = await env.orpc.workspace.slashCommands.list({ workspaceId });

      expect(commands).toContainEqual({ name: "test-cmd" });
    });
  }, 30_000);

  test("listSlashCommands discovers .txt and .md static files", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create static file commands
      await createStaticCommand(metadata.namedWorkspacePath, "txt-cmd", "Text content", ".txt");
      await createStaticCommand(metadata.namedWorkspacePath, "md-cmd", "# Markdown", ".md");

      const commands = await env.orpc.workspace.slashCommands.list({ workspaceId });

      // Commands should be listed by name (without extension)
      expect(commands).toContainEqual({ name: "txt-cmd" });
      expect(commands).toContainEqual({ name: "md-cmd" });
    });
  }, 30_000);

  test("listSlashCommands filters invalid command names", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create valid and invalid commands
      await createExecutableCommand(
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

  test("runSlashCommand reads .txt file verbatim", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createStaticCommand(
        metadata.namedWorkspacePath,
        "static-test",
        "Hello from static file\nSecond line"
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "static-test",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout).toBe("Hello from static file\nSecond line");
        expect(result.data.exitCode).toBe(0);
      }
    });
  }, 30_000);

  test("runSlashCommand reads .md file verbatim", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createStaticCommand(
        metadata.namedWorkspacePath,
        "markdown-test",
        "# Header\n\n- Item 1\n- Item 2",
        ".md"
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "markdown-test",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout).toBe("# Header\n\n- Item 1\n- Item 2");
        expect(result.data.exitCode).toBe(0);
      }
    });
  }, 30_000);

  test("runSlashCommand executes script and returns stdout", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createExecutableCommand(
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

  test("runSlashCommand prefers .txt over executable with same name", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // Create both a static file and an executable with the same base name
      await createStaticCommand(metadata.namedWorkspacePath, "dual", "From static file");
      await createExecutableCommand(
        metadata.namedWorkspacePath,
        "dual",
        '#!/bin/bash\necho "From executable"'
      );

      const result = await env.orpc.workspace.slashCommands.run({
        workspaceId,
        name: "dual",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Should prefer the .txt file
        expect(result.data.stdout).toBe("From static file");
      }
    });
  }, 30_000);

  test("runSlashCommand passes arguments correctly", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createExecutableCommand(
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

  test("runSlashCommand handles exit code 0 as success", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await createExecutableCommand(
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
      await createExecutableCommand(
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
      await createExecutableCommand(
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
