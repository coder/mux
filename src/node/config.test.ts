import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "./config";
import { type ExternalSecretResolver, secretsToRecord } from "@/common/types/secrets";

describe("Config", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadConfigOrDefault with trailing slash migration", () => {
    it("should strip trailing slashes from project paths on load", () => {
      // Create config file with trailing slashes in project paths
      const configFile = path.join(tempDir, "config.json");
      const corruptedConfig = {
        projects: [
          ["/home/user/project/", { workspaces: [] }],
          ["/home/user/another//", { workspaces: [] }],
          ["/home/user/clean", { workspaces: [] }],
        ],
      };
      fs.writeFileSync(configFile, JSON.stringify(corruptedConfig));

      // Load config - should migrate paths
      const loaded = config.loadConfigOrDefault();

      // Verify paths are normalized (no trailing slashes)
      const projectPaths = Array.from(loaded.projects.keys());
      expect(projectPaths).toContain("/home/user/project");
      expect(projectPaths).toContain("/home/user/another");
      expect(projectPaths).toContain("/home/user/clean");
      expect(projectPaths).not.toContain("/home/user/project/");
      expect(projectPaths).not.toContain("/home/user/another//");
    });
  });

  describe("api server settings", () => {
    it("should persist apiServerBindHost, apiServerPort, and apiServerServeWebUi", async () => {
      await config.editConfig((cfg) => {
        cfg.apiServerBindHost = "0.0.0.0";
        cfg.apiServerPort = 3000;
        cfg.apiServerServeWebUi = true;
        return cfg;
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.apiServerBindHost).toBe("0.0.0.0");
      expect(loaded.apiServerPort).toBe(3000);
      expect(loaded.apiServerServeWebUi).toBe(true);
    });

    it("should ignore invalid apiServerPort values on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          apiServerPort: 70000,
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.apiServerPort).toBeUndefined();
    });
  });

  describe("projectKind normalization", () => {
    it("normalizes unknown projectKind to user semantics on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [["/repo", { workspaces: [], projectKind: "experimental" }]],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/repo")?.projectKind).toBeUndefined();
    });

    it("preserves valid projectKind 'system' on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [["/repo", { workspaces: [], projectKind: "system" }]],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.get("/repo")?.projectKind).toBe("system");
    });
  });

  describe("update channel preference", () => {
    it("defaults to stable when no channel is configured", () => {
      expect(config.getUpdateChannel()).toBe("stable");
    });

    it("persists nightly channel selection", async () => {
      await config.setUpdateChannel("nightly");

      const restartedConfig = new Config(tempDir);
      expect(restartedConfig.getUpdateChannel()).toBe("nightly");

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(raw.updateChannel).toBe("nightly");
    });

    it("persists explicit stable channel selection", async () => {
      await config.setUpdateChannel("nightly");
      await config.setUpdateChannel("stable");

      const restartedConfig = new Config(tempDir);
      expect(restartedConfig.getUpdateChannel()).toBe("stable");

      const raw = JSON.parse(fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")) as {
        updateChannel?: unknown;
      };
      expect(raw.updateChannel).toBe("stable");
    });
  });

  describe("server GitHub owner auth setting", () => {
    it("persists serverAuthGithubOwner", async () => {
      await config.editConfig((cfg) => {
        cfg.serverAuthGithubOwner = "octocat";
        return cfg;
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.serverAuthGithubOwner).toBe("octocat");
      expect(config.getServerAuthGithubOwner()).toBe("octocat");
    });

    it("ignores empty serverAuthGithubOwner values on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          serverAuthGithubOwner: "   ",
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.serverAuthGithubOwner).toBeUndefined();
    });
  });

  describe("onePasswordAccountName loading", () => {
    it("loads top-level settings even when projects is missing", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          onePasswordAccountName: "personal-account",
          muxGovernorUrl: "https://governor.example.com",
          terminalDefaultShell: "zsh",
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.size).toBe(0);
      expect(loaded.onePasswordAccountName).toBe("personal-account");
      expect(loaded.muxGovernorUrl).toBe("https://governor.example.com");
      expect(loaded.terminalDefaultShell).toBe("zsh");
    });
  });

  describe("model preferences", () => {
    it("should normalize and persist defaultModel and hiddenModels", async () => {
      await config.editConfig((cfg) => {
        cfg.defaultModel = "mux-gateway:openai/gpt-4o";
        cfg.hiddenModels = [
          " mux-gateway:openai/gpt-4o-mini ",
          "invalid-model",
          "openai:gpt-4o-mini", // duplicate
        ];
        return cfg;
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
    });

    it("normalizes gateway-prefixed model strings on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "mux-gateway:openai/gpt-4o",
          hiddenModels: ["mux-gateway:openai/gpt-4o-mini"],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
    });

    it("rejects malformed mux-gateway model strings on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "mux-gateway:openai", // missing "/model"
          hiddenModels: ["mux-gateway:openai", "openai:gpt-4o-mini"],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBeUndefined();
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
    });

    it("ignores invalid model preference values on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "gpt-4o", // missing provider
          hiddenModels: ["openai:gpt-4o-mini", "bad"],
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBeUndefined();
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
    });
  });
  describe("generateStableId", () => {
    it("should generate a 10-character hex string", () => {
      const id = config.generateStableId();
      expect(id).toMatch(/^[0-9a-f]{10}$/);
    });

    it("should generate unique IDs", () => {
      const id1 = config.generateStableId();
      const id2 = config.generateStableId();
      const id3 = config.generateStableId();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });
  });

  describe("getAllWorkspaceMetadata with migration", () => {
    it("should migrate legacy workspace without metadata file", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "feature-branch");

      // Create workspace directory
      fs.mkdirSync(workspacePath, { recursive: true });

      // Add workspace to config without metadata file
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath }],
        });
        return cfg;
      });

      // Get all metadata (should trigger migration)
      const allMetadata = await config.getAllWorkspaceMetadata();

      expect(allMetadata).toHaveLength(1);
      const metadata = allMetadata[0];
      expect(metadata.id).toBe("project-feature-branch"); // Legacy ID format
      expect(metadata.name).toBe("feature-branch");
      expect(metadata.projectName).toBe("project");
      expect(metadata.projectPath).toBe(projectPath);

      // Verify metadata was migrated to config
      const configData = config.loadConfigOrDefault();
      const projectConfig = configData.projects.get(projectPath);
      expect(projectConfig).toBeDefined();
      expect(projectConfig!.workspaces).toHaveLength(1);
      const workspace = projectConfig!.workspaces[0];
      expect(workspace.id).toBe("project-feature-branch");
      expect(workspace.name).toBe("feature-branch");
    });

    it("should use existing metadata file if present (legacy format)", async () => {
      const projectPath = "/fake/project";
      const workspaceName = "my-feature";
      const workspacePath = path.join(config.srcDir, "project", workspaceName);

      // Create workspace directory
      fs.mkdirSync(workspacePath, { recursive: true });

      // Test backward compatibility: Create metadata file using legacy ID format.
      // This simulates workspaces created before stable IDs were introduced.
      const legacyId = config.generateLegacyId(projectPath, workspacePath);
      const sessionDir = config.getSessionDir(legacyId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const metadataPath = path.join(sessionDir, "metadata.json");
      const existingMetadata = {
        id: legacyId,
        name: workspaceName,
        projectName: "project",
        projectPath: projectPath,
        createdAt: "2025-01-01T00:00:00.000Z",
      };
      fs.writeFileSync(metadataPath, JSON.stringify(existingMetadata));

      // Add workspace to config (without id/name, simulating legacy format)
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath }],
        });
        return cfg;
      });

      // Get all metadata (should use existing metadata and migrate to config)
      const allMetadata = await config.getAllWorkspaceMetadata();

      expect(allMetadata).toHaveLength(1);
      const metadata = allMetadata[0];
      expect(metadata.id).toBe(legacyId);
      expect(metadata.name).toBe(workspaceName);
      expect(metadata.createdAt).toBe("2025-01-01T00:00:00.000Z");

      // Verify metadata was migrated to config
      const configData = config.loadConfigOrDefault();
      const projectConfig = configData.projects.get(projectPath);
      expect(projectConfig).toBeDefined();
      expect(projectConfig!.workspaces).toHaveLength(1);
      const workspace = projectConfig!.workspaces[0];
      expect(workspace.id).toBe(legacyId);
      expect(workspace.name).toBe(workspaceName);
      expect(workspace.createdAt).toBe("2025-01-01T00:00:00.000Z");
    });
  });

  describe("system config layer", () => {
    const originalSystemConfigEnv = process.env.MUX_SYSTEM_CONFIG;

    const writeSystemConfig = (data: Record<string, unknown>) => {
      fs.writeFileSync(path.join(tempDir, "config.system.json"), JSON.stringify(data));
    };

    const writeUserConfig = (data: Record<string, unknown>) => {
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(data));
    };

    beforeEach(() => {
      delete process.env.MUX_SYSTEM_CONFIG;
      config = new Config(tempDir);
    });

    afterEach(() => {
      if (originalSystemConfigEnv === undefined) {
        delete process.env.MUX_SYSTEM_CONFIG;
      } else {
        process.env.MUX_SYSTEM_CONFIG = originalSystemConfigEnv;
      }
    });

    it("system config provides defaults when user config is absent", () => {
      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
        projects: [["/sys/project", { workspaces: [] }]],
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(loaded.projects.get("/sys/project")).toEqual({ workspaces: [] });
    });

    it("preserves system config when user config is malformed", () => {
      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
        projects: [["/sys/project", { workspaces: [] }]],
      });
      fs.writeFileSync(path.join(tempDir, "config.json"), "{ this is not valid json");

      const loaded = config.loadConfigOrDefault();

      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(loaded.projects.get("/sys/project")).toEqual({ workspaces: [] });
    });

    it("user config overrides system config key-by-key", () => {
      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
        defaultProjectDir: "/system/default",
      });
      writeUserConfig({
        defaultModel: "openai:gpt-4o-mini",
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.defaultModel).toBe("openai:gpt-4o-mini");
      expect(loaded.defaultProjectDir).toBe("/system/default");
    });

    it("deep merge for nested objects", () => {
      writeSystemConfig({
        projects: [],
        featureFlagOverrides: {
          flagA: "on",
        },
        agentAiDefaults: {
          plan: {
            modelString: "openai:gpt-4o",
          },
        },
      });
      writeUserConfig({
        projects: [],
        featureFlagOverrides: {
          flagB: "off",
        },
        agentAiDefaults: {
          exec: {
            modelString: "openai:gpt-4o-mini",
            enabled: true,
          },
        },
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.featureFlagOverrides).toEqual({
        flagA: "on",
        flagB: "off",
      });
      expect(loaded.agentAiDefaults).toMatchObject({
        plan: {
          modelString: "openai:gpt-4o",
        },
        exec: {
          modelString: "openai:gpt-4o-mini",
          enabled: true,
        },
      });
    });

    it("array fields use user value entirely (no array merge)", () => {
      writeSystemConfig({
        projects: [],
        hiddenModels: ["openai:gpt-4o-mini"],
      });
      writeUserConfig({
        projects: [],
        hiddenModels: ["openai:gpt-4o"],
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o"]);
    });

    it("system config ignored for writes", async () => {
      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
        projects: [["/sys/project", { workspaces: [] }]],
      });

      const systemConfigPath = path.join(tempDir, "config.system.json");
      const originalSystemConfig = fs.readFileSync(systemConfigPath, "utf-8");

      const loaded = config.loadConfigOrDefault();
      await config.saveConfig(loaded);

      expect(fs.readFileSync(systemConfigPath, "utf-8")).toBe(originalSystemConfig);
    });

    it("system defaults are not materialized into user config on save", async () => {
      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
        featureFlagOverrides: { flagA: "on" },
        projects: [],
      });
      writeUserConfig({
        projects: [["/user/proj", { workspaces: [] }]],
      });

      const loaded = config.loadConfigOrDefault();
      // Verify merge worked
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(loaded.featureFlagOverrides).toEqual({ flagA: "on" });

      // Save — should NOT write system defaults to user config
      await config.saveConfig(loaded);

      const savedRaw = JSON.parse(
        fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")
      ) as Record<string, unknown>;
      expect(savedRaw.defaultModel).toBeUndefined();
      expect(savedRaw.featureFlagOverrides).toBeUndefined();
      // User project should still be there
      expect(savedRaw.projects).toEqual([["/user/proj", expect.any(Object)]]);
    });

    it("system taskSettings and projects are stripped on save", async () => {
      writeSystemConfig({
        taskSettings: { maxConcurrentTasks: 5 },
        projects: [["/sys/project", { workspaces: [] }]],
      });
      writeUserConfig({
        projects: [["/user/project", { workspaces: [] }]],
      });

      const loaded = config.loadConfigOrDefault();
      await config.saveConfig(loaded);

      const savedRaw = JSON.parse(
        fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")
      ) as Record<string, unknown>;
      // System project should not be in saved user config.
      const savedProjects = savedRaw.projects as Array<[string, unknown]>;
      const projectPaths = savedProjects.map(([projectPath]) => projectPath);
      expect(projectPaths).toContain("/user/project");
      expect(projectPaths).not.toContain("/sys/project");
    });

    it("system project paths are normalized before stripping", async () => {
      writeSystemConfig({
        projects: [["/sys/project/", { workspaces: [] }]],
      });
      writeUserConfig({
        projects: [],
      });

      const loaded = config.loadConfigOrDefault();
      // Normalized path (no trailing slash) should be in the loaded config
      expect(loaded.projects.has("/sys/project")).toBe(true);

      await config.saveConfig(loaded);

      const savedRaw = JSON.parse(
        fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")
      ) as Record<string, unknown>;
      // System project should be stripped despite trailing slash mismatch
      const savedProjects = savedRaw.projects as Array<[string, unknown]> | undefined;
      if (savedProjects) {
        const projectPaths = savedProjects.map(([p]) => p);
        expect(projectPaths).not.toContain("/sys/project");
        expect(projectPaths).not.toContain("/sys/project/");
      }
    });

    it("system default used as fallback when user value is invalid", () => {
      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
        projects: [],
      });
      writeUserConfig({
        // Invalid model string that normalizeOptionalModelString will reject
        defaultModel: "not-a-valid-model",
        projects: [],
      });

      const loaded = config.loadConfigOrDefault();

      // System default should be used as fallback since user value is invalid
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
    });

    it("system hiddenModels fallback when all user entries are invalid", () => {
      writeSystemConfig({
        hiddenModels: ["openai:gpt-4o-mini"],
        projects: [],
      });
      writeUserConfig({
        // All entries invalid — normalization strips them to []
        hiddenModels: ["not-a-valid-model"],
        projects: [],
      });

      const loaded = config.loadConfigOrDefault();

      // Should fall back to system hidden models, not empty array
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
    });

    it("user intentionally empty hiddenModels is not overridden by system", () => {
      writeSystemConfig({
        hiddenModels: ["openai:gpt-4o-mini"],
        projects: [],
      });
      writeUserConfig({
        // Explicit empty array — user wants no hidden models
        hiddenModels: [],
        projects: [],
      });

      const loaded = config.loadConfigOrDefault();

      // User's intentional [] should win over system defaults
      expect(loaded.hiddenModels).toEqual([]);
    });

    it("system object defaults are stripped key-by-key on save", async () => {
      writeSystemConfig({
        featureFlagOverrides: { flagA: "on", flagB: "off" },
        projects: [],
      });
      writeUserConfig({
        projects: [],
        featureFlagOverrides: { flagB: "off", flagC: "on" },
      });

      const loaded = config.loadConfigOrDefault();
      // Merged should have all three flags.
      expect(loaded.featureFlagOverrides).toEqual({ flagA: "on", flagB: "off", flagC: "on" });

      await config.saveConfig(loaded);

      const savedRaw = JSON.parse(
        fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")
      ) as Record<string, unknown>;
      // Only user-specific flag should be saved; system defaults stripped.
      expect(savedRaw.featureFlagOverrides).toEqual({ flagC: "on" });
    });

    it("null system config values do not crash save", async () => {
      writeSystemConfig({
        featureFlagOverrides: null as unknown as Record<string, unknown>,
        projects: [],
      });
      writeUserConfig({
        projects: [],
        featureFlagOverrides: { flagA: "on" },
      });

      const loaded = config.loadConfigOrDefault();
      // Should not throw
      await config.saveConfig(loaded);

      const savedRaw = JSON.parse(
        fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")
      ) as Record<string, unknown>;
      expect(savedRaw.featureFlagOverrides).toEqual({ flagA: "on" });
    });

    it("legacy subagentAiDefaults preserved when system provides agentAiDefaults", () => {
      writeSystemConfig({
        agentAiDefaults: {
          plan: { modelString: "openai:gpt-4o" },
        },
        projects: [],
      });
      writeUserConfig({
        subagentAiDefaults: {
          explore: { modelString: "openai:gpt-4o-mini", enabled: true },
        },
        projects: [],
      });

      const loaded = config.loadConfigOrDefault();

      // Both system agentAiDefaults and user legacy subagentAiDefaults should be present.
      // Legacy normalization only carries model/thinking fields.
      expect(loaded.agentAiDefaults).toMatchObject({
        plan: { modelString: "openai:gpt-4o" },
        explore: { modelString: "openai:gpt-4o-mini" },
      });
    });

    it("user-modified system defaults are persisted on save", async () => {
      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
        projects: [],
      });
      writeUserConfig({
        projects: [],
      });

      const loaded = config.loadConfigOrDefault();
      // User overrides the system default
      loaded.defaultModel = "anthropic:claude-sonnet-4-20250514";

      await config.saveConfig(loaded);

      const savedRaw = JSON.parse(
        fs.readFileSync(path.join(tempDir, "config.json"), "utf-8")
      ) as Record<string, unknown>;
      expect(savedRaw.defaultModel).toBe("anthropic:claude-sonnet-4-20250514");
    });

    it("malformed project tuples in system config are filtered", () => {
      writeSystemConfig({
        projects: [
          42,
          null,
          ["/valid/proj", { workspaces: [] }],
          "not-a-tuple",
        ] as unknown as Array<[string, unknown]>,
      });
      writeUserConfig({
        projects: [["/user/proj", { workspaces: [] }]],
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.projects.size).toBe(2);
      expect(loaded.projects.has("/valid/proj")).toBe(true);
      expect(loaded.projects.has("/user/proj")).toBe(true);
    });

    it("MUX_SYSTEM_CONFIG env var overrides system config path", () => {
      const customSystemConfigPath = path.join(tempDir, "custom.system.json");
      fs.writeFileSync(
        customSystemConfigPath,
        JSON.stringify({
          defaultModel: "openai:gpt-4o-mini",
          projects: [["/custom/project", { workspaces: [] }]],
        })
      );

      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
        projects: [["/default/project", { workspaces: [] }]],
      });

      process.env.MUX_SYSTEM_CONFIG = customSystemConfigPath;
      const envConfig = new Config(tempDir);
      const loaded = envConfig.loadConfigOrDefault();

      expect(loaded.defaultModel).toBe("openai:gpt-4o-mini");
      expect(loaded.projects.has("/custom/project")).toBe(true);
      expect(loaded.projects.has("/default/project")).toBe(false);
    });

    it("malformed system config logs warning and falls back to user-only", () => {
      const systemConfigPath = path.join(tempDir, "config.system.json");
      fs.writeFileSync(systemConfigPath, "{ this is not valid json");
      writeUserConfig({
        projects: [],
        defaultModel: "openai:gpt-4o-mini",
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.defaultModel).toBe("openai:gpt-4o-mini");
      expect(config.systemConfigWarnings).toHaveLength(1);
      expect(config.systemConfigWarnings[0]).toContain(systemConfigPath);
    });

    it("non-object JSON system config logs warning and falls back", () => {
      const systemConfigPath = path.join(tempDir, "config.system.json");
      fs.writeFileSync(systemConfigPath, JSON.stringify([1, 2, 3]));
      writeUserConfig({
        projects: [],
        defaultModel: "openai:gpt-4o-mini",
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.defaultModel).toBe("openai:gpt-4o-mini");
      expect(config.systemConfigWarnings).toHaveLength(1);
      expect(config.systemConfigWarnings[0]).toContain("not a JSON object");
    });

    it("permission-denied system config logs warning and falls back", () => {
      if (process.platform === "win32") {
        return;
      }
      // Root bypasses file permissions, so chmod(000) may not trigger EACCES.
      if (process.getuid?.() === 0) {
        return;
      }

      const systemConfigPath = path.join(tempDir, "config.system.json");
      writeSystemConfig({
        defaultModel: "openai:gpt-4o",
      });
      writeUserConfig({
        projects: [],
        defaultModel: "openai:gpt-4o-mini",
      });

      fs.chmodSync(systemConfigPath, 0o000);

      try {
        const loaded = config.loadConfigOrDefault();
        expect(loaded.defaultModel).toBe("openai:gpt-4o-mini");
        expect(config.systemConfigWarnings).toHaveLength(1);
        expect(config.systemConfigWarnings[0]).toContain(systemConfigPath);
      } finally {
        fs.chmodSync(systemConfigPath, 0o644);
      }
    });

    it("binary/garbage system config logs warning and falls back", () => {
      const systemConfigPath = path.join(tempDir, "config.system.json");
      fs.writeFileSync(systemConfigPath, Buffer.from([0x80, 0x81, 0x82, 0x83]));
      writeUserConfig({
        projects: [],
        defaultModel: "openai:gpt-4o-mini",
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.defaultModel).toBe("openai:gpt-4o-mini");
      expect(config.systemConfigWarnings).toHaveLength(1);
      expect(config.systemConfigWarnings[0]).toContain(systemConfigPath);
    });

    it("projects merge: system projects included, user projects override by path", () => {
      writeSystemConfig({
        projects: [
          ["/sys/proj", { workspaces: [{ path: "/system/workspace" }] }],
          ["/sys/only", { workspaces: [{ path: "/system/only" }] }],
        ],
      });
      writeUserConfig({
        projects: [
          ["/sys/proj", { workspaces: [{ path: "/user/override" }], trusted: true }],
          ["/user/proj", { workspaces: [{ path: "/user/project" }] }],
        ],
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.projects.size).toBe(3);
      expect(loaded.projects.get("/sys/proj")).toEqual({
        workspaces: [{ path: "/user/override" }],
        trusted: true,
      });
      expect(loaded.projects.get("/sys/only")).toEqual({
        workspaces: [{ path: "/system/only" }],
      });
      expect(loaded.projects.get("/user/proj")).toEqual({
        workspaces: [{ path: "/user/project" }],
      });
    });

    it("missing system config produces no warning", () => {
      writeUserConfig({
        projects: [],
        defaultModel: "openai:gpt-4o-mini",
      });

      const loaded = config.loadConfigOrDefault();

      expect(loaded.defaultModel).toBe("openai:gpt-4o-mini");
      expect(config.systemConfigWarnings).toEqual([]);
    });
  });

  describe("secrets", () => {
    it("supports global secrets stored under a sentinel key", async () => {
      await config.updateGlobalSecrets([{ key: "GLOBAL_A", value: "1" }]);

      expect(config.getGlobalSecrets()).toEqual([{ key: "GLOBAL_A", value: "1" }]);

      const raw = fs.readFileSync(path.join(tempDir, "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw) as { __global__?: unknown };
      expect(parsed.__global__).toEqual([{ key: "GLOBAL_A", value: "1" }]);
    });

    it("does not inherit global secrets by default", async () => {
      await config.updateGlobalSecrets([
        { key: "TOKEN", value: "global" },
        { key: "A", value: "1" },
      ]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [
        { key: "TOKEN", value: "project" },
        { key: "B", value: "2" },
      ]);

      const effective = config.getEffectiveSecrets(projectPath);
      const record = await secretsToRecord(effective);

      expect(record).toEqual({
        TOKEN: "project",
        B: "2",
      });
    });

    it('resolves project secret aliases to global secrets via {secret:"KEY"}', async () => {
      await config.updateGlobalSecrets([{ key: "GLOBAL_TOKEN", value: "abc" }]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [
        { key: "TOKEN", value: { secret: "GLOBAL_TOKEN" } },
      ]);

      const record = await secretsToRecord(config.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        TOKEN: "abc",
      });
    });

    it("resolves same-key project secret references to global values", async () => {
      await config.updateGlobalSecrets([{ key: "OPENAI_API_KEY", value: "abc" }]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [
        { key: "OPENAI_API_KEY", value: { secret: "OPENAI_API_KEY" } },
      ]);

      const record = await secretsToRecord(config.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        OPENAI_API_KEY: "abc",
      });
    });

    it("resolves project secret aliases to global { op } values", async () => {
      const opRef = "op://Vault/Item/field";
      await config.updateGlobalSecrets([{ key: "GLOBAL_OP", value: { op: opRef } }]);

      const projectPath = "/fake/project";
      await config.updateProjectSecrets(projectPath, [
        { key: "TOKEN", value: { secret: "GLOBAL_OP" } },
      ]);

      const effective = config.getEffectiveSecrets(projectPath);
      expect(effective).toEqual([{ key: "TOKEN", value: { op: opRef } }]);

      const resolver: ExternalSecretResolver = (ref: string) => {
        if (ref === opRef) return Promise.resolve("resolved-op");
        return Promise.resolve(undefined);
      };

      const record = await secretsToRecord(effective, resolver);
      expect(record).toEqual({ TOKEN: "resolved-op" });
    });

    it("omits missing referenced secrets when resolving secretsToRecord", async () => {
      const record = await secretsToRecord([
        { key: "GLOBAL", value: "1" },
        { key: "A", value: { secret: "MISSING" } },
      ]);

      expect(record).toEqual({ GLOBAL: "1" });
    });

    it("omits cyclic secret references when resolving secretsToRecord", async () => {
      const record = await secretsToRecord([
        { key: "A", value: { secret: "B" } },
        { key: "B", value: { secret: "A" } },
        { key: "OK", value: "y" },
      ]);

      expect(record).toEqual({ OK: "y" });
    });

    it("resolves { op } values via external resolver", async () => {
      const resolver: ExternalSecretResolver = (ref: string) => {
        if (ref === "op://Dev/Stripe/key") return Promise.resolve("sk-resolved");
        return Promise.resolve(undefined);
      };

      const record = await secretsToRecord(
        [
          { key: "STRIPE_KEY", value: { op: "op://Dev/Stripe/key" } },
          { key: "LITERAL", value: "plain" },
        ],
        resolver
      );

      expect(record).toEqual({ STRIPE_KEY: "sk-resolved", LITERAL: "plain" });
    });

    it("omits { op } values when no resolver is provided", async () => {
      const record = await secretsToRecord([
        { key: "A", value: { op: "op://Dev/Stripe/key" } },
        { key: "B", value: "literal" },
      ]);

      expect(record).toEqual({ B: "literal" });
    });

    it("omits { op } values when resolver returns undefined", async () => {
      const resolver: ExternalSecretResolver = () => Promise.resolve(undefined);
      const record = await secretsToRecord(
        [{ key: "A", value: { op: "op://Dev/Stripe/key" } }],
        resolver
      );

      expect(record).toEqual({});
    });

    it("resolves mixed literal, { secret }, and { op } values", async () => {
      const resolver: ExternalSecretResolver = (ref: string) => {
        if (ref === "op://Vault/Item/field") return Promise.resolve("op-resolved");
        return Promise.resolve(undefined);
      };

      const record = await secretsToRecord(
        [
          { key: "LITERAL", value: "raw" },
          { key: "GLOBAL_TOKEN", value: "abc" },
          { key: "ALIAS", value: { secret: "GLOBAL_TOKEN" } },
          { key: "OP_REF", value: { op: "op://Vault/Item/field" } },
        ],
        resolver
      );

      expect(record).toEqual({
        LITERAL: "raw",
        GLOBAL_TOKEN: "abc",
        ALIAS: "abc",
        OP_REF: "op-resolved",
      });
    });
    it("normalizes project paths so trailing slashes don't split secrets", async () => {
      const projectPath = "/repo";
      const projectPathWithSlash = "/repo/";

      await config.updateProjectSecrets(projectPathWithSlash, [{ key: "A", value: "1" }]);

      expect(config.getProjectSecrets(projectPath)).toEqual([{ key: "A", value: "1" }]);
      expect(config.getProjectSecrets(projectPathWithSlash)).toEqual([{ key: "A", value: "1" }]);

      const raw = fs.readFileSync(path.join(tempDir, "secrets.json"), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed[projectPath]).toEqual([{ key: "A", value: "1" }]);
      expect(parsed[projectPathWithSlash]).toBeUndefined();
    });

    it("treats malformed store shapes as empty arrays", () => {
      const secretsFile = path.join(tempDir, "secrets.json");
      fs.writeFileSync(
        secretsFile,
        JSON.stringify({
          __global__: { key: "NOPE", value: "1" },
          "/repo": "not-an-array",
          "/repo/": [{ key: "A", value: "1" }, null, { key: 123, value: "x" }],
        })
      );

      expect(config.getGlobalSecrets()).toEqual([]);
      expect(config.getProjectSecrets("/repo")).toEqual([{ key: "A", value: "1" }]);
    });
  });
});
