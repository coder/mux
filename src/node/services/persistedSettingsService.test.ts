import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { PersistedSettingsService } from "./persistedSettingsService";

async function readConfigFile(rootDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.promises.readFile(path.join(rootDir, "config.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("PersistedSettingsService", () => {
  it("persists and returns thinking level per model", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-persisted-settings-"));
    try {
      const config = new Config(tmpDir);
      const service = new PersistedSettingsService(config);

      const result = await service.setAIThinkingLevel("openai:gpt-5.2", "high");
      expect(result.success).toBe(true);

      const settings = service.get();
      expect(settings.ai?.thinkingLevelByModel?.["openai:gpt-5.2"]).toBe("high");

      const raw = await readConfigFile(tmpDir);
      expect(raw.persistedSettings).toBeTruthy();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes mux-gateway models", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-persisted-settings-"));
    try {
      const config = new Config(tmpDir);
      const service = new PersistedSettingsService(config);

      const result = await service.setAIThinkingLevel("mux-gateway:openai/gpt-5.2", "low");
      expect(result.success).toBe(true);

      const settings = service.get();
      expect(settings.ai?.thinkingLevelByModel?.["openai:gpt-5.2"]).toBe("low");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("deletes persistedSettings when last value is removed", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-persisted-settings-"));
    try {
      const config = new Config(tmpDir);
      const service = new PersistedSettingsService(config);

      expect((await service.setAIThinkingLevel("openai:gpt-5.2", "high")).success).toBe(true);
      expect((await service.setAIThinkingLevel("openai:gpt-5.2", null)).success).toBe(true);

      expect(service.get()).toEqual({});

      const raw = await readConfigFile(tmpDir);
      expect(raw.persistedSettings).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
