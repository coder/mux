#!/usr/bin/env bun

import { parseArgs } from "util";
import { listWorkspacesCommand } from "./list-workspaces";
import { costsCommand } from "./costs";
import { sendMessageCommand } from "./send-message";
import { debugExtensionInstallCommand } from "./extensions-install";
import { debugExtensionsCommand } from "./extensions";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    workspace: { type: "string", short: "w" },
    drop: { type: "string", short: "d" },
    limit: { type: "string", short: "l" },
    all: { type: "boolean", short: "a" },
    edit: { type: "string", short: "e" },
    message: { type: "string", short: "m" },
    root: { type: "string", short: "r" },
  },
  allowPositionals: true,
});

const command = positionals[0];

switch (command) {
  case "list-workspaces":
    listWorkspacesCommand();
    break;
  case "costs": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log("Usage: bun debug costs <workspace-id>");
      process.exit(1);
    }
    console.profile("costs");
    await costsCommand(workspaceId);
    console.profileEnd("costs");
    break;
  }
  case "send-message": {
    const workspaceId = positionals[1];
    if (!workspaceId) {
      console.error("Error: workspace ID required");
      console.log(
        "Usage: bun debug send-message <workspace-id> [--edit <message-id>] [--message <text>]"
      );
      process.exit(1);
    }
    sendMessageCommand(workspaceId, values.edit, values.message);
    break;
  }
  case "extensions-install": {
    const coordinate = positionals[1];
    if (!coordinate) {
      console.error("Error: git coordinate required");
      console.log("Usage: bun debug extensions-install <git-url-or-shorthand>[//subdir]@<ref>");
      process.exit(1);
    }
    await debugExtensionInstallCommand(coordinate);
    break;
  }
  case "extensions": {
    await debugExtensionsCommand({ rootId: values.root });
    break;
  }
  default:
    console.log("Usage:");
    console.log("  bun debug list-workspaces");
    console.log("  bun debug costs <workspace-id>");
    console.log("  bun debug send-message <workspace-id> [--edit <message-id>] [--message <text>]");
    console.log("  bun debug extensions-install <git-url-or-shorthand>[//subdir]@<ref>");
    console.log("  bun debug extensions [--root <rootId>]");
    process.exit(1);
}
