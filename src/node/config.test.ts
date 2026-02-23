import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "./config";
import { secretsToRecord } from "@/common/types/secrets";

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

  describe("model preferences", () => {
    it("should normalize and persist defaultModel, hiddenModels, and preferredCompactionModel", async () => {
      await config.editConfig((cfg) => {
        cfg.defaultModel = "mux-gateway:openai/gpt-4o";
        cfg.hiddenModels = [
          " mux-gateway:openai/gpt-4o-mini ",
          "invalid-model",
          "openai:gpt-4o-mini", // duplicate
        ];
        cfg.preferredCompactionModel = "openai:gpt-4o";
        return cfg;
      });

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
      expect(loaded.preferredCompactionModel).toBe("openai:gpt-4o");
    });

    it("normalizes gateway-prefixed model strings on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "mux-gateway:openai/gpt-4o",
          hiddenModels: ["mux-gateway:openai/gpt-4o-mini"],
          preferredCompactionModel: "mux-gateway:openai/gpt-4o",
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBe("openai:gpt-4o");
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
      expect(loaded.preferredCompactionModel).toBe("openai:gpt-4o");
    });

    it("rejects malformed mux-gateway model strings on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "mux-gateway:openai", // missing "/model"
          hiddenModels: ["mux-gateway:openai", "openai:gpt-4o-mini"],
          preferredCompactionModel: "mux-gateway:", // missing provider + "/model"
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBeUndefined();
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
      expect(loaded.preferredCompactionModel).toBeUndefined();
    });

    it("treats empty preferredCompactionModel as unset on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          preferredCompactionModel: "",
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.preferredCompactionModel).toBeUndefined();
    });

    it("ignores invalid model preference values on load", () => {
      const configFile = path.join(tempDir, "config.json");
      fs.writeFileSync(
        configFile,
        JSON.stringify({
          projects: [],
          defaultModel: "gpt-4o", // missing provider
          hiddenModels: ["openai:gpt-4o-mini", "bad"],
          preferredCompactionModel: "   ",
        })
      );

      const loaded = config.loadConfigOrDefault();
      expect(loaded.defaultModel).toBeUndefined();
      expect(loaded.hiddenModels).toEqual(["openai:gpt-4o-mini"]);
      expect(loaded.preferredCompactionModel).toBeUndefined();
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
      const record = secretsToRecord(effective);

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

      const record = secretsToRecord(config.getEffectiveSecrets(projectPath));
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

      const record = secretsToRecord(config.getEffectiveSecrets(projectPath));
      expect(record).toEqual({
        OPENAI_API_KEY: "abc",
      });
    });

    it("omits missing referenced secrets when resolving secretsToRecord", () => {
      const record = secretsToRecord([
        { key: "GLOBAL", value: "1" },
        { key: "A", value: { secret: "MISSING" } },
      ]);

      expect(record).toEqual({ GLOBAL: "1" });
    });

    it("omits cyclic secret references when resolving secretsToRecord", () => {
      const record = secretsToRecord([
        { key: "A", value: { secret: "B" } },
        { key: "B", value: { secret: "A" } },
        { key: "OK", value: "y" },
      ]);

      expect(record).toEqual({ OK: "y" });
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
