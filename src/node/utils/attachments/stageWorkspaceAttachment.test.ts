import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { STAGED_ATTACHMENT_DIR } from "@/common/constants/stagedAttachments";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

import {
  copyStagedWorkspaceAttachments,
  extractStagedAttachmentPathsFromText,
  readStagedWorkspaceAttachment,
  stageWorkspaceAttachment,
} from "./stageWorkspaceAttachment";

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("stageWorkspaceAttachment", () => {
  test("writes zip bytes under the staged attachment directory and keeps git clean", async () => {
    const repo = await makeTempDir("mux-stage-attachment-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      filename: "../../archive.zip",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: Buffer.from(bytes).toString("base64"),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.filename).toBe("archive.zip");
    expect(result.data.stagedPath).toStartWith(`${STAGED_ATTACHMENT_DIR}/`);
    expect(await readFile(path.join(repo, result.data.stagedPath))).toEqual(Buffer.from(bytes));
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status).toBe("");
  });

  test("reads staged zip bytes for download and rejects paths outside staging", async () => {
    const repo = await makeTempDir("mux-stage-attachment-download-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);
    const bytes = Buffer.from("zip bytes");

    const staged = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      filename: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const invalidDownload = await readStagedWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      stagedPath: "../README.md",
    });
    expect(invalidDownload).toEqual({ success: false, error: "Invalid staged attachment path." });

    const downloaded = await readStagedWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      stagedPath: staged.data.stagedPath,
    });

    expect(downloaded).toEqual({
      success: true,
      data: {
        filename: "archive.zip",
        mediaType: "application/zip",
        sizeBytes: bytes.byteLength,
        dataBase64: bytes.toString("base64"),
      },
    });
  });

  test("stages zip files in non-git workspaces", async () => {
    const dir = await makeTempDir("mux-stage-attachment-nongit-");
    const runtime = new LocalRuntime(dir);
    const bytes = Buffer.from("zip");

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: dir,
      filename: "archive.zip",
      mediaType: "",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(await readFile(path.join(dir, result.data.stagedPath), "utf8")).toBe("zip");
  });

  test("copies staged zip attachments into a fork target and keeps git clean", async () => {
    const sourceRepo = await makeTempDir("mux-stage-attachment-copy-source-");
    const targetRepo = await makeTempDir("mux-stage-attachment-copy-target-");
    execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepo, stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main"], { cwd: targetRepo, stdio: "ignore" });
    const sourceRuntime = new LocalRuntime(sourceRepo);
    const targetRuntime = new LocalRuntime(targetRepo);
    const bytes = Buffer.from("forked zip bytes");

    const staged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      filename: "ARCHIVE.ZIP",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const futureStaged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      filename: "future.zip",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(futureStaged.success).toBe(true);
    if (!futureStaged.success) return;

    const copied = await copyStagedWorkspaceAttachments({
      sourceRuntime,
      targetRuntime,
      sourceWorkspacePath: sourceRepo,
      targetWorkspacePath: targetRepo,
      stagedPaths: [staged.data.stagedPath],
    });

    expect(copied).toEqual({ success: true, data: undefined });
    expect(await readFile(path.join(targetRepo, staged.data.stagedPath))).toEqual(bytes);
    let futureAttachmentExists = true;
    try {
      await readFile(path.join(targetRepo, futureStaged.data.stagedPath));
    } catch {
      futureAttachmentExists = false;
    }
    expect(futureAttachmentExists).toBe(false);
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: targetRepo,
      encoding: "utf8",
    });
    expect(status).toBe("");
  });

  test("skips stale referenced staged zip attachments during fork copy", async () => {
    const sourceRepo = await makeTempDir("mux-stage-attachment-stale-source-");
    const targetRepo = await makeTempDir("mux-stage-attachment-stale-target-");
    execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepo, stdio: "ignore" });
    execFileSync("git", ["init", "-b", "main"], { cwd: targetRepo, stdio: "ignore" });
    const sourceRuntime = new LocalRuntime(sourceRepo);
    const targetRuntime = new LocalRuntime(targetRepo);
    const bytes = Buffer.from("still present");

    const staged = await stageWorkspaceAttachment({
      runtime: sourceRuntime,
      workspacePath: sourceRepo,
      filename: "present.zip",
      mediaType: "application/zip",
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
    expect(staged.success).toBe(true);
    if (!staged.success) return;

    const copied = await copyStagedWorkspaceAttachments({
      sourceRuntime,
      targetRuntime,
      sourceWorkspacePath: sourceRepo,
      targetWorkspacePath: targetRepo,
      stagedPaths: [staged.data.stagedPath, ".mux/user-attachments/missing/deleted.zip"],
    });

    expect(copied).toEqual({ success: true, data: undefined });
    expect(await readFile(path.join(targetRepo, staged.data.stagedPath))).toEqual(bytes);
  });

  test("extracts referenced staged attachment paths from persisted text", () => {
    const text =
      "before `.mux/user-attachments/one/ARCHIVE.ZIP` middle `.mux/user-attachments/two/future.zip` after";

    expect(extractStagedAttachmentPathsFromText(text)).toEqual([
      ".mux/user-attachments/one/ARCHIVE.ZIP",
      ".mux/user-attachments/two/future.zip",
    ]);
  });

  test("rejects invalid base64 before writing", async () => {
    const repo = await makeTempDir("mux-stage-attachment-bad-base64-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      filename: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: 0,
      dataBase64: "not base64!",
    });

    expect(result.success).toBe(false);
    expect(
      await Array.fromAsync(new Bun.Glob(`${STAGED_ATTACHMENT_DIR}/**`).scan({ cwd: repo }))
    ).toEqual([]);
  });

  test("rejects invalid payloads before writing", async () => {
    const repo = await makeTempDir("mux-stage-attachment-invalid-");
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const runtime = new LocalRuntime(repo);

    const result = await stageWorkspaceAttachment({
      runtime,
      workspacePath: repo,
      filename: "archive.txt",
      mediaType: "text/plain",
      sizeBytes: 3,
      dataBase64: Buffer.from("zip").toString("base64"),
    });

    expect(result.success).toBe(false);
    expect(
      await Array.fromAsync(new Bun.Glob(`${STAGED_ATTACHMENT_DIR}/**`).scan({ cwd: repo }))
    ).toEqual([]);
  });
});
