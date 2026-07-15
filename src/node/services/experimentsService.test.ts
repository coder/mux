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
            [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: {
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
    expect(values[EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]).toEqual({
      value: "test",
      source: "cache",
    });

    expect(setFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
      "test"
    );
  });

  test("isExperimentLocallyEnabled requires a local override; remote/cached assignment never satisfies it", async () => {
    const cacheFilePath = path.join(tempDir, "feature_flags.json");
    // Seed a cached remote assignment that turns the experiment ON.
    await fs.writeFile(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          experiments: {
            [EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT]: {
              value: true,
              fetchedAtMs: Date.now(),
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const telemetryService = {
      getPostHogClient: mock(() => ({
        getFeatureFlag: mock(() => Promise.resolve(true)),
      })),
      getDistinctId: mock(() => "distinct-id"),
      setFeatureFlagVariant: mock(() => undefined),
    } as unknown as TelemetryService;

    const service = new ExperimentsService({
      telemetryService,
      muxHome: tempDir,
      cacheTtlMs: 60 * 60 * 1000,
    });
    await service.initialize();

    // Remote/cached assignment enables the regular gate...
    expect(service.isExperimentEnabled(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT)).toBe(true);
    // ...but must never satisfy the security-sensitive local-consent gate.
    expect(service.isExperimentLocallyEnabled(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT)).toBe(false);

    await service.setOverride(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT, true);
    expect(service.isExperimentLocallyEnabled(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT)).toBe(true);

    // Clearing the override falls back to remote assignment for the regular
    // gate, while the local gate turns off again.
    await service.setOverride(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT, null);
    expect(service.isExperimentLocallyEnabled(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT)).toBe(false);
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
    await service.refreshExperiment(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);

    const value = service.getExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
    expect(value.value).toBe("test");
    expect(value.source).toBe("posthog");

    const cacheFilePath = path.join(tempDir, "feature_flags.json");
    const disk = JSON.parse(await fs.readFile(cacheFilePath, "utf-8")) as unknown;
    expect(typeof disk).toBe("object");

    expect((disk as { version: unknown }).version).toBe(1);
    expect((disk as { experiments: Record<string, unknown> }).experiments).toHaveProperty(
      EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING
    );

    expect(setFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
      "test"
    );
  });

  test("persists backend overrides and applies them before remote gating", async () => {
    const setFeatureFlagVariant = mock(() => undefined);
    const telemetryService = {
      getPostHogClient: mock(() => null),
      getDistinctId: mock(() => null),
      setFeatureFlagVariant,
    } as unknown as TelemetryService;

    const service = new ExperimentsService({ telemetryService, muxHome: tempDir });
    await service.initialize();
    await service.setOverride(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES, true);

    expect(service.getExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)).toEqual({
      value: true,
      source: "override",
    });
    expect(service.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)).toBe(true);
    expect(setFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
      true
    );

    const cacheFilePath = path.join(tempDir, "feature_flags.json");
    const disk = JSON.parse(await fs.readFile(cacheFilePath, "utf-8")) as {
      overrides?: Record<string, unknown>;
    };
    expect(disk.overrides).toEqual({
      [EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES]: true,
    });

    const reloadedSetFeatureFlagVariant = mock(() => undefined);
    const reloadedTelemetryService = {
      getPostHogClient: mock(() => null),
      getDistinctId: mock(() => null),
      setFeatureFlagVariant: reloadedSetFeatureFlagVariant,
    } as unknown as TelemetryService;

    const reloadedService = new ExperimentsService({
      telemetryService: reloadedTelemetryService,
      muxHome: tempDir,
    });
    await reloadedService.initialize();

    expect(reloadedService.getExperimentValue(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)).toEqual({
      value: true,
      source: "override",
    });
    expect(reloadedService.isExperimentEnabled(EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES)).toBe(true);
    expect(reloadedSetFeatureFlagVariant).toHaveBeenCalledWith(
      EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES,
      true
    );
  });

  test("platform-restricted experiments stay disabled on unsupported platforms", async () => {
    const cacheFilePath = path.join(tempDir, "feature_flags.json");
    await fs.writeFile(
      cacheFilePath,
      JSON.stringify(
        {
          version: 1,
          experiments: {
            [EXPERIMENT_IDS.PORTABLE_DESKTOP]: {
              value: true,
              fetchedAtMs: Date.now(),
            },
          },
          overrides: {
            [EXPERIMENT_IDS.PORTABLE_DESKTOP]: true,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const setFeatureFlagVariant = mock(() => undefined);
    const telemetryService = {
      getPostHogClient: mock(() => null),
      getDistinctId: mock(() => null),
      setFeatureFlagVariant,
    } as unknown as TelemetryService;

    const service = new ExperimentsService({
      telemetryService,
      muxHome: tempDir,
      platform: "darwin",
    });
    await service.initialize();

    expect(service.getExperimentValue(EXPERIMENT_IDS.PORTABLE_DESKTOP)).toEqual({
      value: null,
      source: "disabled",
    });
    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PORTABLE_DESKTOP)).toBe(false);

    await service.setOverride(EXPERIMENT_IDS.PORTABLE_DESKTOP, true);

    const disk = JSON.parse(await fs.readFile(cacheFilePath, "utf-8")) as {
      overrides?: Record<string, unknown>;
    };
    expect(disk.overrides).toEqual({});
    expect(setFeatureFlagVariant).toHaveBeenCalledWith(EXPERIMENT_IDS.PORTABLE_DESKTOP, null);
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
    expect(values[EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]).toEqual({
      value: null,
      source: "disabled",
    });

    expect(service.isExperimentEnabled(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING)).toBe(false);
  });
});
