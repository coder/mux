import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { VoiceService } from "./voiceService";

async function withTempConfig(
  run: (config: Config, service: VoiceService) => Promise<void>
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-voice-service-"));
  try {
    const config = new Config(tmpDir);
    const service = new VoiceService(config);
    await run(config, service);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("VoiceService.transcribe", () => {
  it("returns provider-disabled error without calling fetch", async () => {
    await withTempConfig(async (config, service) => {
      config.saveProvidersConfig({
        openai: {
          apiKey: "sk-test",
          enabled: false,
        },
      });

      const fetchSpy = spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValue(new Response("transcribed text"));

      try {
        const result = await service.transcribe("Zm9v");

        expect(result).toEqual({
          success: false,
          error:
            "OpenAI provider is disabled. Enable it in Settings → Providers to use voice input.",
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
