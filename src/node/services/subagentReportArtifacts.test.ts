import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  readSubagentReportArtifactsFile,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";

describe("subagentReportArtifacts", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-subagent-report-"));
  });

  afterEach(async () => {
    await fsPromises.rm(testDir, { recursive: true, force: true });
  });

  test("upsertSubagentReportArtifact computes reportTokenEstimate", async () => {
    const workspaceId = "parent-1";
    const childTaskId = "child-1";
    const markdown = "A".repeat(400);

    await upsertSubagentReportArtifact({
      workspaceId,
      workspaceSessionDir: testDir,
      childTaskId,
      parentWorkspaceId: workspaceId,
      ancestorWorkspaceIds: [workspaceId],
      reportMarkdown: markdown,
      title: "token-estimate-test",
      nowMs: Date.now(),
    });

    const artifacts = await readSubagentReportArtifactsFile(testDir);
    const entry = artifacts.artifactsByChildTaskId[childTaskId];

    expect(entry).toBeDefined();
    expect(entry?.reportTokenEstimate).toBe(100);
  });
});
