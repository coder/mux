import { describe, expect, it } from "bun:test";

import { AppConfigOnDiskSchema } from "./appConfigOnDisk";
import { SettingsBackupSchema } from "./settingsBackup";

describe("AppConfigOnDiskSchema", () => {
  it("validates default model setting", () => {
    const valid = { defaultModel: "anthropic:claude-sonnet-4-20250514" };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates hiddenModels array", () => {
    const valid = { hiddenModels: ["openai:gpt-4o", "google:gemini-pro"] };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
  });

  it("validates the full-width chat transcript flag", () => {
    expect(AppConfigOnDiskSchema.safeParse({ chatTranscriptFullWidth: true }).success).toBe(true);
    expect(AppConfigOnDiskSchema.safeParse({ chatTranscriptFullWidth: "true" }).success).toBe(
      false
    );
  });

  it("validates userPreferences", () => {
    const valid = {
      userPreferences: {
        appearance: { theme: "dark" },
      },
    };

    expect(AppConfigOnDiskSchema.safeParse(valid).success).toBe(true);
    expect(
      AppConfigOnDiskSchema.safeParse({ userPreferences: { appearance: { theme: "neon" } } })
        .success
    ).toBe(false);
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

  it("holds settingsBackup to the shape the backup API returns", () => {
    const stored = { repoUrl: "git@example.com:me/dotfiles.git", branch: "main", path: "mux" };
    const parsed = AppConfigOnDiskSchema.safeParse({ settingsBackup: stored });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.settingsBackup).toEqual(stored);

    // A value the backup API rejects must degrade to "not configured" rather than fail the
    // whole config parse and take every other setting down with it.
    for (const unusable of [
      { repoUrl: "", branch: "main", path: "mux" },
      { repoUrl: "git@example.com:me/dotfiles.git", branch: "main", path: "." },
      { repoUrl: "https://oauth2:hunter2@example.com/repo.git", branch: "main", path: "mux" },
    ]) {
      expect(SettingsBackupSchema.safeParse(unusable).success).toBe(false);
      const degraded = AppConfigOnDiskSchema.safeParse({
        settingsBackup: unusable,
        defaultModel: "openai:gpt-4o",
      });
      expect(degraded.success).toBe(true);
      if (degraded.success) {
        expect(degraded.data.settingsBackup).toBeUndefined();
        expect(degraded.data.defaultModel).toBe("openai:gpt-4o");
      }
    }
  });

  it("rejects a backup repository URL that embeds a credential", () => {
    const base = { branch: "main", path: "mux" };
    for (const repoUrl of [
      // A bare https username is the common PAT spelling, not routing.
      "https://hunter2token@github.com/me/dotfiles.git",
      "https://oauth2:hunter2@example.com/repo.git",
      "https://oauth2:hunter2@",
      "https:/oauth2:hunter2@",
      "https:\\oauth2:hunter2@",
      "ssh://user:hunter2@example.com/repo.git",
      "ssh://user:hunter2@",
      "https://example.com/repo.git?access_token=hunter2",
      "https://example.com/repo.git#access_token=hunter2",
    ]) {
      expect(SettingsBackupSchema.safeParse({ ...base, repoUrl }).success).toBe(false);
    }
    for (const repoUrl of [
      "https://github.com/me/dotfiles.git",
      "https://github.com/me/dotfiles.git?client_id=mux",
      "https://github.com/me/dotfiles.git?code=review&key=branch&session=docs",
      "https://github.com/me/dotfiles.git#section=backup",
      "ssh://git@example.com/repo.git",
      "git@github.com:me/dotfiles.git",
    ]) {
      expect(SettingsBackupSchema.safeParse({ ...base, repoUrl }).success).toBe(true);
    }
  });

  it("rejects invalid backup branch names", () => {
    const base = {
      repoUrl: "https://github.com/me/dotfiles.git",
      path: "mux",
    };
    for (const branch of [
      "my branch",
      "-backup",
      ".backup",
      "feature/.backup",
      "feature.lock",
      "feature/backup.lock",
      "feature..backup",
      "feature~backup",
      "feature^backup",
      "feature:backup",
      "feature?backup",
      "feature*backup",
      "feature[backup",
      "feature\\backup",
      "/feature",
      "feature/",
      "feature//backup",
      "feature.",
      "feature@{backup",
      "refs/heads/main",
      "HEAD",
    ]) {
      expect(SettingsBackupSchema.safeParse({ ...base, branch }).success).toBe(false);
    }
    for (const branch of [
      "main",
      "feature/backup",
      "feature/-backup",
      "release/v1.0+build",
      "feature/backup.LOCK",
      "@",
      "føø/backup",
    ]) {
      expect(SettingsBackupSchema.safeParse({ ...base, branch }).success).toBe(true);
    }
  });

  it("accepts sparse configs", () => {
    expect(AppConfigOnDiskSchema.safeParse({ defaultModel: "openai:gpt-4o" }).success).toBe(true);
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
