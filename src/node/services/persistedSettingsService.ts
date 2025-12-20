import { EventEmitter } from "events";
import type { Config } from "@/node/config";
import { PersistedSettingsSchema } from "@/common/orpc/schemas";
import type { PersistedSettings } from "@/common/orpc/types";
import type { ThinkingLevel } from "@/common/types/thinking";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { Err, Ok, type Result } from "@/common/types/result";
import { log } from "@/node/services/log";

export class PersistedSettingsService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly config: Config) {}

  onChanged(callback: () => void): () => void {
    this.emitter.on("changed", callback);
    return () => this.emitter.off("changed", callback);
  }

  private emitChanged(): void {
    this.emitter.emit("changed");
  }

  get(): PersistedSettings {
    const cfg = this.config.loadConfigOrDefault();

    // Validate before exposing over RPC so corrupted config doesn’t crash the UI.
    const result = PersistedSettingsSchema.safeParse(cfg.persistedSettings ?? {});
    if (!result.success) {
      log.warn("Invalid persistedSettings in config.json; ignoring:", result.error);
      return {};
    }

    return result.data;
  }

  async setAIThinkingLevel(
    model: string,
    thinkingLevel: ThinkingLevel | null
  ): Promise<Result<void, string>> {
    try {
      const normalizedModel = normalizeGatewayModel(model);

      let changed = false;

      await this.config.editConfig((config) => {
        const parsed = PersistedSettingsSchema.safeParse(config.persistedSettings ?? {});
        const currentSettings = parsed.success ? parsed.data : {};
        const currentByModel = currentSettings.ai?.thinkingLevelByModel ?? {};

        const prev = currentByModel[normalizedModel];
        if (thinkingLevel === prev || (thinkingLevel === null && prev === undefined)) {
          return config;
        }

        changed = true;

        const nextByModel = { ...currentByModel };
        if (thinkingLevel === null) {
          delete nextByModel[normalizedModel];
        } else {
          nextByModel[normalizedModel] = thinkingLevel;
        }

        const hasAnyThinking = Object.keys(nextByModel).length > 0;
        const nextAI = hasAnyThinking
          ? { ...(currentSettings.ai ?? {}), thinkingLevelByModel: nextByModel }
          : (() => {
              if (!currentSettings.ai) {
                return undefined;
              }
              const { thinkingLevelByModel: _removed, ...rest } = currentSettings.ai;
              return Object.keys(rest).length > 0 ? rest : undefined;
            })();

        const nextSettings: PersistedSettings = {
          ...currentSettings,
          ai: nextAI,
        };

        const isEmpty =
          nextSettings.ai === undefined &&
          (nextSettings.projectDefaults === undefined ||
            Object.keys(nextSettings.projectDefaults).length === 0);

        return {
          ...config,
          persistedSettings: isEmpty ? undefined : nextSettings,
        };
      });

      if (changed) {
        this.emitChanged();
      }

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to set thinking level: ${message}`);
    }
  }
}
