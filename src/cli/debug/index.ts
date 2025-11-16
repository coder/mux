#!/usr/bin/env bun

import { parseArgs } from "util";
import { listWorkspacesCommand } from "./list-workspaces";
import { costsCommand } from "./costs";
import { sendMessageCommand } from "./send-message";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    workspace: { type: "string", short: "w" },
    drop: { type: "string", short: "d" },
    limit: { type: "string", short: "l" },
    all: { type: "boolean", short: "a" },
    edit: { type: "string", short: "e" },
    message: { type: "string", short: "m" },
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
  default:
    console.log("Usage:");
    console.log("  bun debug list-workspaces");
    console.log("  bun debug costs <workspace-id>");
    console.log("  bun debug send-message <workspace-id> [--edit <message-id>] [--message <text>]");
    process.exit(1);
}
