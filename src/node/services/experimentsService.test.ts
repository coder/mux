import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { ExperimentsService } from "./experimentsService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { TelemetryService } from "./telemetryService";
import type { PostHog } from "posthog-node";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

describe("ExperimentsService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-experiments-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("loads cached experiment values from disk and exposes them", async () => {
    const cacheFilePath = path.join(tempDir, "feature_flags.json");
    await fs.writeFile(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          experiments: {
            [EXPERIMENT_IDS.POST_COMPACTION_CONTEXT]: {
              value: "test",
              fetchedAtMs: Date.now(),
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const setFeatureFlagVariant = mock(() => undefined);
    const fakePostHog = {
      getFeatureFlag: mock(() => Promise.resolve("test")),
    } as unknown as PostHog;

    const telemetryService = {
      getPostHogClient: mock(() => fakePostHog),
      getDistinctId: mock(() => "distinct-id"),
      setFeatureFlagVariant,
    } as unknown as TelemetryService;

    const service = new ExperimentsService({
      telemetryService,
      muxHome: tempDir,
      cacheTtlMs: 60 * 60 * 1000,
    });

    await service.initialize();

    const values = service.getAll();
    expect(values[EXPERIMENT_IDS.POST_COMPACTION_CONTEXT]).toEqual({
      value: "test",
      source: "cache",
    });

    expect(setFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.POST_COMPACTION_CONTEXT,
      "test"
    );
  });

  test("refreshExperiment updates cache and writes it to disk", async () => {
    const setFeatureFlagVariant = mock(() => undefined);
    const fakePostHog = {
      getFeatureFlag: mock(() => Promise.resolve("test")),
    } as unknown as PostHog;

    const telemetryService = {
      getPostHogClient: mock(() => fakePostHog),
      getDistinctId: mock(() => "distinct-id"),
      setFeatureFlagVariant,
    } as unknown as TelemetryService;

    const service = new ExperimentsService({
      telemetryService,
      muxHome: tempDir,
      cacheTtlMs: 0,
    });

    await service.initialize();
    await service.refreshExperiment(EXPERIMENT_IDS.POST_COMPACTION_CONTEXT);

    const value = service.getExperimentValue(EXPERIMENT_IDS.POST_COMPACTION_CONTEXT);
    expect(value.value).toBe("test");
    expect(value.source).toBe("posthog");

    const cacheFilePath = path.join(tempDir, "feature_flags.json");
    const disk = JSON.parse(await fs.readFile(cacheFilePath, "utf-8")) as unknown;
    expect(typeof disk).toBe("object");

    expect((disk as { version: unknown }).version).toBe(1);
    expect((disk as { experiments: Record<string, unknown> }).experiments).toHaveProperty(
      EXPERIMENT_IDS.POST_COMPACTION_CONTEXT
    );

    expect(setFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.POST_COMPACTION_CONTEXT,
      "test"
    );
  });

  test("returns disabled when telemetry is disabled", async () => {
    const telemetryService = {
      getPostHogClient: mock(() => null),
      getDistinctId: mock(() => null),
      setFeatureFlagVariant: mock(() => undefined),
    } as unknown as TelemetryService;

    const service = new ExperimentsService({ telemetryService, muxHome: tempDir });
    await service.initialize();

    const values = service.getAll();
    expect(values[EXPERIMENT_IDS.POST_COMPACTION_CONTEXT]).toEqual({
      value: null,
      source: "disabled",
    });

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.POST_COMPACTION_CONTEXT)).toBe(false);
  });
});
