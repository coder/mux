import * as fs from "fs";
import { mkdir, readFile, readdir, writeFile, access } from "fs/promises";
import { constants } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROJECT_EXTENSION_STATE_SCHEMA_VERSION } from "@/common/extensions/projectExtensionState";
import { ProjectExtensionStateService } from "./projectExtensionStateService";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("ProjectExtensionStateService", () => {
  let projectDir: string;
  let stateDir: string;
  let service: ProjectExtensionStateService;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-project-ext-state-project-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-project-ext-state-store-"));
    service = new ProjectExtensionStateService(stateDir);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("load() with no file returns empty state and no diagnostics", async () => {
    const result = await service.load(projectDir);
    expect(result.state).toEqual({
      schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
      rootTrusted: false,
      extensions: {},
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.schemaVersionMismatch).toBe(false);
  });

  test("setRootTrusted(true) round-trips through disk", async () => {
    await service.setRootTrusted(projectDir, true);
    const result = await service.load(projectDir);
    expect(result.state.rootTrusted).toBe(true);
    expect(await service.isRootTrusted(projectDir)).toBe(true);
  });

  test("setEnabled round-trips through disk", async () => {
    await service.setEnabled(projectDir, "publisher.alpha", false);
    const result = await service.load(projectDir);
    expect(result.state.extensions["publisher.alpha"]).toEqual({ enabled: false });
  });

  test("setApproval persists approval permissions hash", async () => {
    const approval = {
      grantedPermissions: ["network", "skill.register"],
      requestedPermissionsHash: "deadbeef",
    };
    await service.setApproval(projectDir, "publisher.alpha", approval);
    const result = await service.load(projectDir);
    expect(result.state.extensions["publisher.alpha"]).toEqual({ approval });
  });

  test("removeApproval drops approval but preserves enablement", async () => {
    await service.setEnabled(projectDir, "publisher.alpha", false);
    await service.setApproval(projectDir, "publisher.alpha", {
      grantedPermissions: [],
      requestedPermissionsHash: "abc",
    });
    await service.removeApproval(projectDir, "publisher.alpha");
    const result = await service.load(projectDir);
    expect(result.state.extensions["publisher.alpha"]).toEqual({ enabled: false });
  });

  test("forget removes the entire record", async () => {
    await service.setEnabled(projectDir, "publisher.alpha", true);
    await service.forget(projectDir, "publisher.alpha");
    const result = await service.load(projectDir);
    expect(result.state.extensions["publisher.alpha"]).toBeUndefined();
  });

  test("write produces no .tmp leftovers (atomic rename)", async () => {
    await service.setEnabled(projectDir, "publisher.alpha", true);
    const stateFileDir = path.dirname(service.filePathFor(projectDir));
    const entries = await readdir(stateFileDir);
    const leftovers = entries.filter(
      (f) => f.startsWith("extensions.local.jsonc") && f !== "extensions.local.jsonc"
    );
    expect(leftovers).toEqual([]);
  });

  test("untrust round-trip: setRootTrusted(true) then setRootTrusted(false) reflects on load (caller can clear watcher)", async () => {
    await service.setRootTrusted(projectDir, true);
    expect((await service.load(projectDir)).state.rootTrusted).toBe(true);

    await service.setRootTrusted(projectDir, false);
    const after = await service.load(projectDir);
    expect(after.state.rootTrusted).toBe(false);
  });

  test("untrust preserves approval records on disk", async () => {
    await service.setRootTrusted(projectDir, true);
    await service.setApproval(projectDir, "publisher.alpha", {
      grantedPermissions: ["network"],
      requestedPermissionsHash: "abc",
    });
    await service.setRootTrusted(projectDir, false);
    const after = await service.load(projectDir);
    expect(after.state.rootTrusted).toBe(false);
    expect(after.state.extensions["publisher.alpha"]?.approval).toBeDefined();
  });

  test("invariant: empty/missing state never implies trust", async () => {
    expect(await service.isRootTrusted(projectDir)).toBe(false);
  });

  test("recovery: malformed (non-JSON) file → empty state, file is not deleted", async () => {
    const filePath = service.filePathFor(projectDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{ this is not valid json", "utf-8");

    const { state } = await service.load(projectDir);
    expect(state).toEqual({
      schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
      rootTrusted: false,
      extensions: {},
    });
    expect(await pathExists(filePath)).toBe(true);
  });

  test("recovery: unknown future schemaVersion → empty runtime state, file preserved on disk", async () => {
    const filePath = service.filePathFor(projectDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    const futureBlock = {
      schemaVersion: 99,
      rootTrusted: true,
      extensions: { "publisher.future": { enabled: true, somethingNew: 1 } },
    };
    await writeFile(filePath, JSON.stringify(futureBlock), "utf-8");

    const result = await service.load(projectDir);
    expect(result.schemaVersionMismatch).toBe(true);
    expect(result.state.rootTrusted).toBe(false);
    expect(result.state.extensions).toEqual({});
    expect(
      result.diagnostics.some((d) => d.code === "extension.state.schema_version.unsupported")
    ).toBe(true);

    const onDisk = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    expect(onDisk).toEqual(futureBlock);
  });

  test("recovery: per-record validation failure drops only the bad record with info diagnostic", async () => {
    const filePath = service.filePathFor(projectDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        extensions: {
          "publisher.good": { enabled: true },
          "publisher.bad": { enabled: 1234 },
        },
      }),
      "utf-8"
    );
    const { state, diagnostics } = await service.load(projectDir);
    expect(state.extensions).toEqual({ "publisher.good": { enabled: true } });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "extension.state.record.invalid",
      severity: "info",
      extensionId: "publisher.bad",
    });
  });

  test("schemaVersion mismatch + subsequent setEnabled rewrites file at current schemaVersion", async () => {
    const filePath = service.filePathFor(projectDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 99,
        rootTrusted: true,
        extensions: { "publisher.future": { enabled: true } },
      }),
      "utf-8"
    );
    expect((await service.load(projectDir)).schemaVersionMismatch).toBe(true);

    await service.setEnabled(projectDir, "publisher.alpha", true);
    const after = await service.load(projectDir);
    expect(after.schemaVersionMismatch).toBe(false);
    expect(after.state.extensions).toEqual({ "publisher.alpha": { enabled: true } });
    // rootTrusted from the unknown schema is treated as empty; the write does
    // not silently retain it.
    expect(after.state.rootTrusted).toBe(false);
  });

  test("state file lives outside the project repository", async () => {
    await service.setRootTrusted(projectDir, true);
    const filePath = service.filePathFor(projectDir);

    expect(filePath.startsWith(projectDir + path.sep)).toBe(false);
    expect(filePath.startsWith(stateDir + path.sep)).toBe(true);
    expect(await pathExists(path.join(projectDir, ".mux", "extensions.local.jsonc"))).toBe(false);
  });

  test("committed-looking repo state file cannot inject trust", async () => {
    const repoStatePath = path.join(projectDir, ".mux", "extensions.local.jsonc");
    await mkdir(path.dirname(repoStatePath), { recursive: true });
    await writeFile(
      repoStatePath,
      JSON.stringify({
        schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
        rootTrusted: true,
        extensions: { "publisher.injected": { enabled: true } },
      }),
      "utf-8"
    );

    const result = await service.load(projectDir);
    expect(result.state.rootTrusted).toBe(false);
    expect(result.state.extensions).toEqual({});
  });

  test("non-git project: write succeeds without touching the project tree", async () => {
    await service.setRootTrusted(projectDir, true);
    expect((await service.load(projectDir)).state.rootTrusted).toBe(true);
    expect(await pathExists(path.join(projectDir, ".git"))).toBe(false);
    expect(await pathExists(path.join(projectDir, ".mux"))).toBe(false);
  });

  test("file is JSON-parseable (jsonc reads JSON)", async () => {
    await service.setRootTrusted(projectDir, true);
    await service.setEnabled(projectDir, "publisher.alpha", true);

    const filePath = service.filePathFor(projectDir);
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as {
      schemaVersion: number;
      rootTrusted?: boolean;
      extensions?: Record<string, { enabled?: boolean }>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.rootTrusted).toBe(true);
    expect(parsed.extensions?.["publisher.alpha"]).toEqual({ enabled: true });
  });
});
