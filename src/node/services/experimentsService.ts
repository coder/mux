import assert from "@/common/utils/assert";
import {
  EXPERIMENTS,
  isExperimentSupportedOnPlatform,
  type ExperimentId,
} from "@/common/constants/experiments";
import { getMuxHome } from "@/common/constants/paths";
import type { TelemetryService } from "@/node/services/telemetryService";

import * as fs from "fs/promises";
import writeFileAtomic from "write-file-atomic";
import * as path from "path";

interface ExperimentsFile {
  version: 1;
  /**
   * Always written as an empty object. Builds before remote evaluation was removed
   * abort reading this file when `experiments` is absent, which would silently drop
   * the user's overrides on downgrade.
   */
  experiments: Record<string, never>;
  overrides?: Record<string, boolean>;
}

const OVERRIDES_FILE_NAME = "feature_flags.json";
const OVERRIDES_FILE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Backend experiments service.
 *
 * Experiments are opt-in local toggles: an experiment is enabled only when the user
 * explicitly turns it on in Settings. Overrides are persisted so main-process gates
 * (oRPC routes, AI runtime, tool registration) agree with the renderer on every launch.
 */
export class ExperimentsService {
  private readonly telemetryService: TelemetryService;
  private readonly muxHome: string;
  private readonly overridesFilePath: string;
  private readonly platform: NodeJS.Platform;

  private readonly overrides = new Map<ExperimentId, boolean>();

  private initialized = false;

  constructor(options: {
    telemetryService: TelemetryService;
    muxHome?: string;
    platform?: NodeJS.Platform;
  }) {
    this.telemetryService = options.telemetryService;
    this.muxHome = options.muxHome ?? getMuxHome();
    this.overridesFilePath = path.join(this.muxHome, OVERRIDES_FILE_NAME);
    this.platform = options.platform ?? process.platform;
  }

  private isExperimentSupported(experimentId: ExperimentId): boolean {
    return isExperimentSupportedOnPlatform(experimentId, this.platform);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.loadOverridesFromDisk();
    this.initialized = true;

    for (const [experimentId, enabled] of this.overrides) {
      this.telemetryService.setFeatureFlagVariant(
        experimentId,
        this.isExperimentSupported(experimentId) ? enabled : null
      );
    }
  }

  /**
   * Replace all overrides with the renderer's complete local state. Overrides absent
   * from `next` are cleared rather than left behind, so backend gates can never stay
   * enabled for an experiment the user's Settings shows as off.
   */
  async syncOverrides(next: Partial<Record<ExperimentId, boolean>>): Promise<void> {
    await this.ensureInitialized();

    const previous = new Set(this.overrides.keys());
    this.overrides.clear();

    for (const [key, enabled] of Object.entries(next)) {
      const experimentId = key as ExperimentId;
      assert(experimentId in EXPERIMENTS, `Unknown experimentId: ${experimentId}`);
      if (typeof enabled !== "boolean" || !this.isExperimentSupported(experimentId)) {
        continue;
      }

      this.overrides.set(experimentId, enabled);
    }

    for (const experimentId of previous) {
      if (!this.overrides.has(experimentId)) {
        this.telemetryService.setFeatureFlagVariant(experimentId, null);
      }
    }

    for (const [experimentId, enabled] of this.overrides) {
      this.telemetryService.setFeatureFlagVariant(experimentId, enabled);
    }

    await this.writeOverridesToDisk();
  }

  /**
   * True only when the user has explicitly enabled the experiment in Settings.
   * Nothing else can enable an experiment, so security-sensitive gates (e.g. skill
   * dynamic context injection, which executes repo-controlled shell commands) can
   * rely on this meaning deliberate local consent.
   */
  isExperimentEnabled(experimentId: ExperimentId): boolean {
    assert(experimentId in EXPERIMENTS, `Unknown experimentId: ${experimentId}`);

    if (!this.isExperimentSupported(experimentId)) {
      return false;
    }

    return this.overrides.get(experimentId) === true;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.initialize();
    assert(this.initialized, "ExperimentsService failed to initialize");
  }

  private async loadOverridesFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.overridesFilePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      if (!isRecord(parsed) || parsed.version !== OVERRIDES_FILE_VERSION) {
        return;
      }

      const overrides = parsed.overrides;
      if (!isRecord(overrides)) {
        return;
      }

      for (const [key, value] of Object.entries(overrides)) {
        if (!(key in EXPERIMENTS) || typeof value !== "boolean") {
          continue;
        }

        this.overrides.set(key as ExperimentId, value);
      }
    } catch {
      // Ignore missing/corrupt overrides
    }
  }

  private async writeOverridesToDisk(): Promise<void> {
    try {
      const overrides: NonNullable<ExperimentsFile["overrides"]> = {};
      for (const [experimentId, enabled] of this.overrides) {
        overrides[experimentId] = enabled;
      }

      const payload: ExperimentsFile = {
        version: OVERRIDES_FILE_VERSION,
        experiments: {},
        overrides,
      };

      await fs.mkdir(this.muxHome, { recursive: true });
      await writeFileAtomic(this.overridesFilePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch {
      // Ignore persistence failures
    }
  }
}
