import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Config } from "@/node/config";

describe("Config telemetryEnabled persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-telemetry-enabled-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("fails closed when config.json exists but cannot be parsed", async () => {
    const config = new Config(tempDir);
    // Fresh install (no file) is not an error: telemetry stays enabled.
    expect(config.isTelemetryDisabledByConfig()).toBe(false);

    // A corrupted file must not silently override a possible opt-out:
    // unreadable persisted state reports disabled.
    await fs.writeFile(path.join(tempDir, "config.json"), "{ not json", "utf-8");
    expect(config.isTelemetryDisabledByConfig()).toBe(true);
  });

  it("round-trips the opt-out through editConfig saves and reports it", async () => {
    const config = new Config(tempDir);
    expect(config.isTelemetryDisabledByConfig()).toBe(false);

    await config.editConfig((cfg) => ({ ...cfg, telemetryEnabled: false }));

    // A fresh instance re-reads from disk: the field must survive the
    // whitelist-based saveConfig serialization.
    const reloaded = new Config(tempDir);
    expect(reloaded.loadConfigOrDefault().telemetryEnabled).toBe(false);
    expect(reloaded.isTelemetryDisabledByConfig()).toBe(true);

    // Clearing the field (re-enable) must persist too.
    await reloaded.editConfig((cfg) => ({ ...cfg, telemetryEnabled: undefined }));
    const cleared = new Config(tempDir);
    expect(cleared.loadConfigOrDefault().telemetryEnabled).toBeUndefined();
    expect(cleared.isTelemetryDisabledByConfig()).toBe(false);
  });
});
