import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { ProviderService } from "./providerService";

describe("ProviderService.getConfig", () => {
  it("surfaces valid OpenAI serviceTier", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
    try {
      const config = new Config(tmpDir);
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          serviceTier: "flex",
        },
      });

      const service = new ProviderService(config);
      const cfg = service.getConfig();

      expect(cfg.openai.apiKeySet).toBe(true);
      expect(cfg.openai.serviceTier).toBe("flex");
      expect(Object.prototype.hasOwnProperty.call(cfg.openai, "serviceTier")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omits invalid OpenAI serviceTier", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-service-"));
    try {
      const config = new Config(tmpDir);
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          // Intentionally invalid
          serviceTier: "fast",
        },
      });

      const service = new ProviderService(config);
      const cfg = service.getConfig();

      expect(cfg.openai.apiKeySet).toBe(true);
      expect(cfg.openai.serviceTier).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(cfg.openai, "serviceTier")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
