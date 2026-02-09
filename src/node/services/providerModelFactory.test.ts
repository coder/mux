import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { ProviderModelFactory } from "./providerModelFactory";
import { ProviderService } from "./providerService";

describe("ProviderModelFactory.createModel", () => {
  it("returns provider_disabled when a non-gateway provider is disabled", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-provider-model-factory-"));

    try {
      const config = new Config(tmpDir);
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
      });

      const providerService = new ProviderService(config);
      const factory = new ProviderModelFactory(config, providerService);

      const result = await factory.createModel("openai:gpt-5");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toEqual({
          type: "provider_disabled",
          provider: "openai",
        });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
