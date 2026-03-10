import { describe, expect, it } from "bun:test";

import { AppConfigOnDiskSchema } from "./appConfigOnDisk";

describe("AppConfigOnDiskSchema", () => {
  it("validates default model setting", () => {
    const valid = { defaultModel: "anthropic:claude-sonnet-4-20250514" };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates hiddenModels array", () => {
    const valid = { hiddenModels: ["openai:gpt-4o", "google:gemini-pro"] };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates taskSettings with limits", () => {
    const valid = {
      taskSettings: {
        maxParallelAgentTasks: 5,
        maxTaskNestingDepth: 3,
      },
    };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects taskSettings outside limits", () => {
    const invalid = {
      taskSettings: {
        maxParallelAgentTasks: 999,
      },
    };

    expect(AppConfigOnDiskSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates projects as tuple array", () => {
    const valid = { projects: [["/home/user/project", { workspaces: [] }]] };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts sparse runtimeEnablement overrides", () => {
    expect(AppConfigOnDiskSchema.safeParse({ runtimeEnablement: { ssh: false } }).success).toBe(
      true
    );
  });

  it("rejects runtimeEnablement values other than false", () => {
    expect(AppConfigOnDiskSchema.safeParse({ runtimeEnablement: { ssh: true } }).success).toBe(
      false
    );
  });

  it("preserves unknown future runtimeEnablement keys for forward-compatibility", () => {
    expect(
      AppConfigOnDiskSchema.safeParse({
        runtimeEnablement: { ssh: false, future_runtime: false },
      }).success
    ).toBe(true);
  });

  it("accepts missing eventSoundSettings", () => {
    const result = AppConfigOnDiskSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventSoundSettings).toBeUndefined();
    }
  });

  it("parses valid eventSoundSettings and applies entry defaults", () => {
    const result = AppConfigOnDiskSchema.safeParse({
      eventSoundSettings: {
        agent_review_ready: {
          enabled: true,
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventSoundSettings).toEqual({
        agent_review_ready: {
          enabled: true,
          source: null,
        },
      });
    }
  });

  it("preserves unknown eventSoundSettings keys", () => {
    const result = AppConfigOnDiskSchema.safeParse({
      eventSoundSettings: {
        future_event: {
          source: {
            kind: "managed",
            assetId: "11111111-1111-1111-1111-111111111111.wav",
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventSoundSettings).toEqual({
        future_event: {
          enabled: false,
          source: {
            kind: "managed",
            assetId: "11111111-1111-1111-1111-111111111111.wav",
          },
        },
      });
    }
  });

  it("rejects legacy eventSoundSettings filePath entries", () => {
    expect(
      AppConfigOnDiskSchema.safeParse({
        eventSoundSettings: {
          agent_review_ready: {
            filePath: "/tmp/legacy.wav",
          },
        },
      }).success
    ).toBe(false);
  });

  it("rejects unknown event sound source kinds", () => {
    expect(
      AppConfigOnDiskSchema.safeParse({
        eventSoundSettings: {
          agent_review_ready: {
            source: {
              kind: "external",
              assetId: "anything",
            },
          },
        },
      }).success
    ).toBe(false);
  });

  it("preserves unknown fields via passthrough", () => {
    const valid = { futureField: "something" };

    const result = AppConfigOnDiskSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ futureField: "something" });
    }
  });
});
