import type { Config } from "@/node/config";
import type { TelemetryService } from "@/node/services/telemetryService";
import { FEATURE_FLAG_KEYS } from "@/common/constants/featureFlags";
import type { StatsTabOverride, StatsTabState, StatsTabVariant } from "./sessionTimingService";

const FLAG_CACHE_TTL_MS = 10 * 60 * 1000;

export class FeatureFlagService {
  private readonly config: Config;
  private readonly telemetryService: TelemetryService;

  private cachedVariant: { value: StatsTabVariant; fetchedAt: number } | null = null;

  constructor(config: Config, telemetryService: TelemetryService) {
    this.config = config;
    this.telemetryService = telemetryService;
  }

  private getOverride(): StatsTabOverride {
    return this.config.getFeatureFlagOverride(FEATURE_FLAG_KEYS.statsTabV1);
  }

  private async getVariant(): Promise<StatsTabVariant> {
    const now = Date.now();
    if (this.cachedVariant && now - this.cachedVariant.fetchedAt < FLAG_CACHE_TTL_MS) {
      return this.cachedVariant.value;
    }

    const value = await this.telemetryService.getFeatureFlag(FEATURE_FLAG_KEYS.statsTabV1);

    const variant: StatsTabVariant = value === true || value === "stats" ? "stats" : "control";

    this.cachedVariant = { value: variant, fetchedAt: now };
    return variant;
  }

  async getStatsTabState(): Promise<StatsTabState> {
    const override = this.getOverride();
    const variant = await this.getVariant();

    const enabled = override === "on" ? true : override === "off" ? false : variant === "stats";

    return { enabled, variant, override };
  }

  async setStatsTabOverride(override: StatsTabOverride): Promise<StatsTabState> {
    await this.config.setFeatureFlagOverride(FEATURE_FLAG_KEYS.statsTabV1, override);
    return this.getStatsTabState();
  }
}
