import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export const LARGE_CHANGE_ROOT = "src/review/perf-large-change";
const LARGE_CHANGE_GROUP_COUNT = 20;
const LARGE_CHANGE_BUCKETS_PER_GROUP = 10;
const LARGE_CHANGE_FILES_PER_BUCKET = 5;
const LARGE_CHANGE_FILE_COUNT =
  LARGE_CHANGE_GROUP_COUNT * LARGE_CHANGE_BUCKETS_PER_GROUP * LARGE_CHANGE_FILES_PER_BUCKET;

export interface LargeReviewDiffSummary {
  rootPath: string;
  fileCount: number;
  directoryCount: number;
  hunkCount: number;
  addedLines: number;
  deletedLines: number;
}

function runGitCommand(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status === 0) {
    return result.stdout;
  }

  const stderr = result.stderr.trim();
  throw new Error(
    `git ${args.join(" ")} failed in ${cwd}: ${stderr || `exit ${result.status ?? "unknown"}`}`
  );
}

function buildLargeReviewFixtureSource(fileIndex: number, variant: "base" | "modified"): string {
  const fileId = String(fileIndex + 1).padStart(3, "0");
  const status = variant === "base" ? "pending" : "ready";

  return [
    `export const reviewProbe${fileId} = {`,
    `  id: ${fileIndex + 1},`,
    `  status: "${status}",`,
    `  checksum: ${5_000 + fileIndex},`,
    `  summary: "Perf review probe ${fileId}",`,
    "};",
    "",
  ].join("\n");
}

export function seedLargeReviewDiff(workspacePath: string): LargeReviewDiffSummary {
  const filePaths: string[] = [];
  let fileIndex = 0;

  for (let groupIndex = 0; groupIndex < LARGE_CHANGE_GROUP_COUNT; groupIndex += 1) {
    const groupId = String(groupIndex + 1).padStart(2, "0");
    for (let bucketIndex = 0; bucketIndex < LARGE_CHANGE_BUCKETS_PER_GROUP; bucketIndex += 1) {
      const bucketId = String(bucketIndex + 1).padStart(2, "0");
      for (
        let bucketFileIndex = 0;
        bucketFileIndex < LARGE_CHANGE_FILES_PER_BUCKET;
        bucketFileIndex += 1
      ) {
        const relativePath = [
          LARGE_CHANGE_ROOT,
          `group-${groupId}`,
          `bucket-${bucketId}`,
          `probe-${String(fileIndex + 1).padStart(3, "0")}.ts`,
        ].join("/");
        const filePath = path.join(workspacePath, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buildLargeReviewFixtureSource(fileIndex, "base"), "utf-8");
        filePaths.push(relativePath);
        fileIndex += 1;
      }
    }
  }

  if (filePaths.length !== LARGE_CHANGE_FILE_COUNT) {
    throw new Error(
      `Expected ${LARGE_CHANGE_FILE_COUNT} generated files, received ${filePaths.length}`
    );
  }

  runGitCommand(workspacePath, ["add", LARGE_CHANGE_ROOT]);
  runGitCommand(workspacePath, ["commit", "-q", "-m", "Seed review perf fixture"]);

  for (const [index, relativePath] of filePaths.entries()) {
    const filePath = path.join(workspacePath, ...relativePath.split("/"));
    fs.writeFileSync(filePath, buildLargeReviewFixtureSource(index, "modified"), "utf-8");
  }

  const diffOutput = runGitCommand(workspacePath, ["diff", "HEAD"]);
  const hunkCount = (diffOutput.match(/^@@/gm) ?? []).length;
  if (hunkCount !== filePaths.length) {
    throw new Error(`Expected ${filePaths.length} hunks in seeded diff, received ${hunkCount}`);
  }

  let addedLines = 0;
  let deletedLines = 0;
  const numstatOutput = runGitCommand(workspacePath, ["diff", "HEAD", "--numstat"]).trim();
  for (const line of numstatOutput.split("\n").filter(Boolean)) {
    const [addedText = "0", deletedText = "0"] = line.split("\t");
    addedLines += Number.parseInt(addedText, 10) || 0;
    deletedLines += Number.parseInt(deletedText, 10) || 0;
  }

  return {
    rootPath: LARGE_CHANGE_ROOT,
    fileCount: filePaths.length,
    directoryCount:
      2 + LARGE_CHANGE_GROUP_COUNT + LARGE_CHANGE_GROUP_COUNT * LARGE_CHANGE_BUCKETS_PER_GROUP,
    hunkCount,
    addedLines,
    deletedLines,
  };
}
