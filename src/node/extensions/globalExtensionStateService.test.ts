import * as fs from "fs";
import { mkdir, readFile, readdir, writeFile, access } from "fs/promises";
import { constants } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config } from "@/node/config";
import { GLOBAL_EXTENSION_STATE_SCHEMA_VERSION } from "@/common/extensions/globalExtensionState";
import { GlobalExtensionStateService } from "./globalExtensionStateService";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("GlobalExtensionStateService", () => {
  let tempDir: string;
  let config: Config;
  let service: GlobalExtensionStateService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-global-ext-state-"));
    config = new Config(tempDir);
    service = new GlobalExtensionStateService(config);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("load() with no config file returns empty state and no diagnostics", () => {
    const result = service.load();
    expect(result.state).toEqual({
      schemaVersion: GLOBAL_EXTENSION_STATE_SCHEMA_VERSION,
      extensions: {},
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.schemaVersionMismatch).toBe(false);
  });

  test("setEnabled round-trips through disk", async () => {
    await service.setEnabled("publisher.alpha", false);
    const result = service.load();
    expect(result.state.extensions["publisher.alpha"]).toEqual({ enabled: false });
    expect(result.diagnostics).toEqual([]);
  });

  test("setApproval persists approval permissions hash", async () => {
    const approval = {
      grantedPermissions: ["network", "skill.register"],
      requestedPermissionsHash: "deadbeef",
    };
    await service.setApproval("publisher.alpha", approval);
    const result = service.load();
    expect(result.state.extensions["publisher.alpha"]).toEqual({ approval });
  });

  test("removeApproval drops approval but preserves enablement", async () => {
    await service.setEnabled("publisher.alpha", false);
    await service.setApproval("publisher.alpha", {
      grantedPermissions: [],
      requestedPermissionsHash: "abc",
    });
    await service.removeApproval("publisher.alpha");
    const result = service.load();
    expect(result.state.extensions["publisher.alpha"]).toEqual({ enabled: false });
  });

  test("forget removes the entire record", async () => {
    await service.setEnabled("publisher.alpha", true);
    await service.forget("publisher.alpha");
    const result = service.load();
    expect(result.state.extensions["publisher.alpha"]).toBeUndefined();
  });

  test("atomic temp-rename preserves unrelated config fields", async () => {
    await config.editConfig((cfg) => {
      cfg.defaultProjectDir = "/tmp/projects";
      cfg.viewedSplashScreens = ["intro"];
      return cfg;
    });
    await service.setEnabled("publisher.alpha", true);
    const reloaded = config.loadConfigOrDefault();
    expect(reloaded.defaultProjectDir).toBe("/tmp/projects");
    expect(reloaded.viewedSplashScreens).toEqual(["intro"]);
    expect(service.load().state.extensions["publisher.alpha"]).toEqual({ enabled: true });
  });

  test("write produces no .tmp leftovers (atomic rename)", async () => {
    await service.setEnabled("publisher.alpha", true);
    const entries = await readdir(tempDir);
    const leftovers = entries.filter((f) => f.startsWith("config.json") && f !== "config.json");
    expect(leftovers).toEqual([]);
  });

  test("invariant: empty/missing state never implies enabled for non-bundled", () => {
    expect(service.isEnabled("publisher.unknown", { isBundled: false })).toBe(false);
  });

  test("invariant: empty state defaults bundled extensions to enabled: true", () => {
    expect(service.isEnabled("mux.platformdemo", { isBundled: true })).toBe(true);
  });

  test("invariant: empty state never implies approvals", () => {
    const grant = service.load().state.extensions["publisher.alpha"]?.approval;
    expect(grant).toBeUndefined();
  });

  test("malformed bundled state restores default enabled: true for bundled", async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        extensions: {
          schemaVersion: 1,
          extensions: { "mux.platformdemo": { enabled: "broken" } },
        },
      }),
      "utf-8"
    );
    const fresh = new GlobalExtensionStateService(new Config(tempDir));
    const { state, diagnostics } = fresh.load();
    expect(state.extensions["mux.platformdemo"]).toBeUndefined();
    expect(diagnostics.some((d) => d.code === "extension.state.record.invalid")).toBe(true);
    expect(fresh.isEnabled("mux.platformdemo", { isBundled: true })).toBe(true);
  });

  test("recovery: missing/malformed file → empty state, file is not deleted", async () => {
    await mkdir(tempDir, { recursive: true });
    const cfgPath = path.join(tempDir, "config.json");
    await writeFile(cfgPath, "{ this is not valid json", "utf-8");
    const fresh = new GlobalExtensionStateService(new Config(tempDir));
    const { state } = fresh.load();
    expect(state.extensions).toEqual({});
    expect(await pathExists(cfgPath)).toBe(true);
  });

  test("recovery: unknown future schemaVersion → empty runtime state, file preserved on disk", async () => {
    await mkdir(tempDir, { recursive: true });
    const cfgPath = path.join(tempDir, "config.json");
    const futureBlock = {
      schemaVersion: 99,
      extensions: { "publisher.future": { enabled: true, somethingNew: 1 } },
    };
    await writeFile(cfgPath, JSON.stringify({ extensions: futureBlock }), "utf-8");

    const fresh = new GlobalExtensionStateService(new Config(tempDir));
    const result = fresh.load();
    expect(result.schemaVersionMismatch).toBe(true);
    expect(result.state.extensions).toEqual({});
    expect(
      result.diagnostics.some((d) => d.code === "extension.state.schema_version.unsupported")
    ).toBe(true);

    const onDisk = JSON.parse(await readFile(cfgPath, "utf-8")) as { extensions?: unknown };
    expect(onDisk.extensions).toEqual(futureBlock);
  });

  test("recovery: per-record validation failure drops only the bad record with info diagnostic", async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        extensions: {
          schemaVersion: 1,
          extensions: {
            "publisher.good": { enabled: true },
            "publisher.bad": { enabled: 1234 },
          },
        },
      }),
      "utf-8"
    );
    const fresh = new GlobalExtensionStateService(new Config(tempDir));
    const { state, diagnostics } = fresh.load();
    expect(state.extensions).toEqual({ "publisher.good": { enabled: true } });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "extension.state.record.invalid",
      severity: "info",
      extensionId: "publisher.bad",
    });
  });

  test("schemaVersion mismatch + subsequent setEnabled rewrites block to current schemaVersion", async () => {
    await mkdir(tempDir, { recursive: true });
    const cfgPath = path.join(tempDir, "config.json");
    await writeFile(
      cfgPath,
      JSON.stringify({
        extensions: { schemaVersion: 99, extensions: { "publisher.future": { enabled: true } } },
      }),
      "utf-8"
    );
    const fresh = new GlobalExtensionStateService(new Config(tempDir));
    expect(fresh.load().schemaVersionMismatch).toBe(true);
    await fresh.setEnabled("publisher.alpha", true);
    const after = fresh.load();
    expect(after.schemaVersionMismatch).toBe(false);
    expect(after.state.extensions).toEqual({ "publisher.alpha": { enabled: true } });
  });
});
