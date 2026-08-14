import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Config } from "@/node/config";

describe("Config model classes persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-model-classes-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips modelClasses and skillModelClasses through editConfig saves", async () => {
    const config = new Config(tempDir);
    await config.editConfig((cfg) => ({
      ...cfg,
      modelClasses: { small: "haiku+0", large: "anthropic:claude-fable-5+max" },
      skillModelClasses: { done: "small" },
    }));

    // A fresh instance re-reads from disk: the fields must survive the
    // whitelist-based saveConfig serialization.
    const reloaded = new Config(tempDir).loadConfigOrDefault();
    expect(reloaded.modelClasses).toEqual({
      small: "haiku+0",
      large: "anthropic:claude-fable-5+max",
    });
    expect(reloaded.skillModelClasses).toEqual({ done: "small" });

    // An unrelated edit (another full save cycle) must not strip them.
    const second = new Config(tempDir);
    await second.editConfig((cfg) => ({ ...cfg, defaultModel: "anthropic:claude-opus-5" }));
    const reloadedAgain = new Config(tempDir).loadConfigOrDefault();
    expect(reloadedAgain.modelClasses?.small).toBe("haiku+0");
    expect(reloadedAgain.skillModelClasses?.done).toBe("small");
  });

  it("drops non-string entries on load instead of failing (self-healing)", async () => {
    await fs.writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        projects: [],
        modelClasses: { small: "haiku+0", bad: 42 },
        skillModelClasses: 7,
      })
    );

    const loaded = new Config(tempDir).loadConfigOrDefault();
    expect(loaded.modelClasses).toEqual({ small: "haiku+0" });
    expect(loaded.skillModelClasses).toBeUndefined();
  });
});
