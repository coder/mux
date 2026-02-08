import assert from "@/common/utils/assert";
import { EXPERIMENTS, type ExperimentId } from "@/common/constants/experiments";
import { getMuxHome } from "@/common/constants/paths";
import type { ExperimentValue } from "@/common/orpc/types";
import { log } from "@/node/services/log";
import type { TelemetryService } from "@/node/services/telemetryService";

import * as fs from "fs/promises";
import writeFileAtomic from "write-file-atomic";
import * as path from "path";
import { getErrorMessage } from "@/common/utils/errors";

export type { ExperimentValue };

interface CachedVariant {
  value: string | boolean;
  fetchedAtMs: number;
  source: "posthog" | "cache";
}

interface ExperimentsCacheFile {
  version: 1;
  experiments: Record<string, { value: string | boolean; fetchedAtMs: number }>;
}

const CACHE_FILE_NAME = "feature_flags.json";
const CACHE_FILE_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Backend experiments service.
 *
 * Evaluates PostHog feature flags in the main process (via posthog-node) and exposes
 * the current assignments to the renderer via oRPC.
 *
 * Design goals:
 * - Never block user flows on network calls (use cached values and refresh in background)
 * - Fail closed (unknown = control/disabled)
 * - Avoid calling PostHog when telemetry is disabled
 */
export class ExperimentsService {
  private readonly telemetryService: TelemetryService;
  private readonly muxHome: string;
  private readonly cacheFilePath: string;
  private readonly cacheTtlMs: number;

  private readonly cachedVariants = new Map<ExperimentId, CachedVariant>();
  private readonly refreshInFlight = new Map<ExperimentId, Promise<void>>();

  private cacheLoaded = false;

  constructor(options: {
    telemetryService: TelemetryService;
    muxHome?: string;
    cacheTtlMs?: number;
  }) {
    this.telemetryService = options.telemetryService;
    this.muxHome = options.muxHome ?? getMuxHome();
    this.cacheFilePath = path.join(this.muxHome, CACHE_FILE_NAME);
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async initialize(): Promise<void> {
    if (this.cacheLoaded) {
      return;
    }

    await this.loadCacheFromDisk();
    this.cacheLoaded = true;

    // Populate telemetry properties from cache immediately so variant breakdowns
    // are present even before a background refresh completes.
    for (const [experimentId, cached] of this.cachedVariants) {
      this.telemetryService.setFeatureFlagVariant(this.getFlagKey(experimentId), cached.value);
    }

    // Refresh in background (best effort). We only refresh values that are stale or missing
    // to avoid unnecessary network calls during startup.
    if (this.isRemoteEvaluationEnabled()) {
      for (const experimentId of Object.keys(EXPERIMENTS) as ExperimentId[]) {
        this.maybeRefreshInBackground(experimentId);
      }
    }
  }

  isRemoteEvaluationEnabled(): boolean {
    return (
      this.telemetryService.getPostHogClient() !== null &&
      this.telemetryService.getDistinctId() !== null
    );
  }

  /**
   * Return current values for all known experiments.
   * This is used to render Settings → Experiments.
   */
  getAll(): Record<ExperimentId, ExperimentValue> {
    const result: Partial<Record<ExperimentId, ExperimentValue>> = {};

    for (const experimentId of Object.keys(EXPERIMENTS) as ExperimentId[]) {
      result[experimentId] = this.getExperimentValue(experimentId);
    }

    return result as Record<ExperimentId, ExperimentValue>;
  }

  getExperimentValue(experimentId: ExperimentId): ExperimentValue {
    assert(experimentId in EXPERIMENTS, `Unknown experimentId: ${experimentId}`);

    if (!this.isRemoteEvaluationEnabled()) {
      return { value: null, source: "disabled" };
    }

    const cached = this.cachedVariants.get(experimentId);
    if (!cached) {
      // No cached value yet. Fail closed, but kick off a background refresh.
      this.maybeRefreshInBackground(experimentId);
      return { value: null, source: "cache" };
    }

    this.maybeRefreshInBackground(experimentId);
    return { value: cached.value, source: cached.source };
  }

  /**
   * Convert an experiment assignment to a boolean gate.
   *
   * NOTE: This intentionally does not block on network calls.
   */
  isExperimentEnabled(experimentId: ExperimentId): boolean {
    const value = this.getExperimentValue(experimentId).value;

    // PostHog can return either boolean flags or string variants.
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      // For now, treat variant "test" as enabled for experiments with control/test variants.
      // If we add experiments with different variant semantics, add a mapping per experiment.
      return value === "test";
    }

    return false;
  }

  async refreshAll(): Promise<void> {
    await this.ensureInitialized();

    if (!this.isRemoteEvaluationEnabled()) {
      return;
    }

    await Promise.all(
      (Object.keys(EXPERIMENTS) as ExperimentId[]).map(async (experimentId) => {
        await this.refreshExperiment(experimentId);
      })
    );
  }

  async refreshExperiment(experimentId: ExperimentId): Promise<void> {
    await this.ensureInitialized();
    assert(experimentId in EXPERIMENTS, `Unknown experimentId: ${experimentId}`);

    if (!this.isRemoteEvaluationEnabled()) {
      return;
    }

    const existing = this.refreshInFlight.get(experimentId);
    if (existing) {
      return existing;
    }

    const promise = this.refreshExperimentImpl(experimentId).finally(() => {
      this.refreshInFlight.delete(experimentId);
    });

    this.refreshInFlight.set(experimentId, promise);
    return promise;
  }

  private async refreshExperimentImpl(experimentId: ExperimentId): Promise<void> {
    const client = this.telemetryService.getPostHogClient();
    const distinctId = this.telemetryService.getDistinctId();
    assert(client, "PostHog client must exist when remote evaluation is enabled");
    assert(distinctId, "distinctId must exist when remote evaluation is enabled");

    const flagKey = this.getFlagKey(experimentId);

    try {
      const value = await client.getFeatureFlag(flagKey, distinctId);
      if (typeof value !== "string" && typeof value !== "boolean") {
        return;
      }

      const cached: CachedVariant = {
        value,
        fetchedAtMs: Date.now(),
        source: "posthog",
      };

      this.cachedVariants.set(experimentId, cached);
      this.telemetryService.setFeatureFlagVariant(flagKey, value);

      await this.writeCacheToDisk();
    } catch (error) {
      log.debug("Failed to refresh experiment from PostHog", {
        experimentId,
        error: getErrorMessage(error),
      });
    }
  }

  private maybeRefreshInBackground(experimentId: ExperimentId): void {
    const cached = this.cachedVariants.get(experimentId);
    if (!cached) {
      void this.refreshExperiment(experimentId);
      return;
    }

    if (Date.now() - cached.fetchedAtMs > this.cacheTtlMs) {
      void this.refreshExperiment(experimentId);
    }
  }

  private getFlagKey(experimentId: ExperimentId): string {
    // Today, our experiment IDs are already PostHog flag keys.
    // If that ever changes, this is the single mapping point.
    return experimentId;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.cacheLoaded) {
      return;
    }

    await this.initialize();
    assert(this.cacheLoaded, "ExperimentsService failed to initialize");
  }

  private async loadCacheFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.cacheFilePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      if (!isRecord(parsed)) {
        return;
      }

      const version = parsed.version;
      const experiments = parsed.experiments;

      if (version !== CACHE_FILE_VERSION || !isRecord(experiments)) {
        return;
      }

      for (const [key, value] of Object.entries(experiments)) {
        if (!(key in EXPERIMENTS) || !isRecord(value)) {
          continue;
        }

        const fetchedAtMs = value.fetchedAtMs;
        const variant = value.value;

        if (typeof fetchedAtMs !== "number" || !Number.isFinite(fetchedAtMs)) {
          continue;
        }

        if (typeof variant !== "string" && typeof variant !== "boolean") {
          continue;
        }

        this.cachedVariants.set(key as ExperimentId, {
          value: variant,
          fetchedAtMs,
          source: "cache",
        });
      }
    } catch {
      // Ignore missing/corrupt cache
    }
  }

  private async writeCacheToDisk(): Promise<void> {
    try {
      const experiments: ExperimentsCacheFile["experiments"] = {};
      for (const [experimentId, cached] of this.cachedVariants) {
        experiments[experimentId] = {
          value: cached.value,
          fetchedAtMs: cached.fetchedAtMs,
        };
      }

      const payload: ExperimentsCacheFile = {
        version: CACHE_FILE_VERSION,
        experiments,
      };

      await fs.mkdir(this.muxHome, { recursive: true });
      await writeFileAtomic(this.cacheFilePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch {
      // Ignore cache persistence failures
    }
  }
}
