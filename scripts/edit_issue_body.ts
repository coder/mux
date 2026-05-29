#!/usr/bin/env bun

import { $ } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Check if issue number is provided
const issueNumber = process.argv[2];
if (!issueNumber) {
  console.error("Usage: ./edit_issue_body.ts <issue-number>");
  process.exit(1);
}

// Create a temporary directory and file
const tempDir = mkdtempSync(join(tmpdir(), "gh-issue-"));
const tempFile = join(tempDir, "issue-body.md");

try {
  // Get the current issue body
  const result = await $`gh issue view ${issueNumber} --json body -q .body`.text();
  writeFileSync(tempFile, result);

  // Determine which editor to use
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";

  // Open the issue body in the editor with proper TTY
  const proc = Bun.spawn([editor, tempFile], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error("Editor exited with error, aborting update");
    process.exit(1);
  }

  // Update the issue with the edited body
  await $`gh issue edit ${issueNumber} --body-file ${tempFile}`;
  console.log("Issue updated successfully");
} finally {
  // Clean up temp directory
  rmSync(tempDir, { recursive: true, force: true });
}
