import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "./config";

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

  describe("workspace MCP overrides", () => {
    it("should return undefined for non-existent workspace", () => {
      const result = config.getWorkspaceMCPOverrides("non-existent-id");
      expect(result).toBeUndefined();
    });

    it("should return undefined for workspace without MCP overrides", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "branch");

      fs.mkdirSync(workspacePath, { recursive: true });

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath, id: "test-ws-id", name: "branch" }],
        });
        return cfg;
      });

      const result = config.getWorkspaceMCPOverrides("test-ws-id");
      expect(result).toBeUndefined();
    });

    it("should set and get MCP overrides for a workspace", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "branch");

      fs.mkdirSync(workspacePath, { recursive: true });

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath, id: "test-ws-id", name: "branch" }],
        });
        return cfg;
      });

      // Set overrides
      await config.setWorkspaceMCPOverrides("test-ws-id", {
        disabledServers: ["server-a", "server-b"],
        toolAllowlist: { "server-c": ["tool1", "tool2"] },
      });

      // Get overrides
      const result = config.getWorkspaceMCPOverrides("test-ws-id");
      expect(result).toBeDefined();
      expect(result!.disabledServers).toEqual(["server-a", "server-b"]);
      expect(result!.toolAllowlist).toEqual({ "server-c": ["tool1", "tool2"] });
    });

    it("should remove MCP overrides when set to empty", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "branch");

      fs.mkdirSync(workspacePath, { recursive: true });

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [
            {
              path: workspacePath,
              id: "test-ws-id",
              name: "branch",
              mcp: { disabledServers: ["server-a"] },
            },
          ],
        });
        return cfg;
      });

      // Clear overrides
      await config.setWorkspaceMCPOverrides("test-ws-id", {});

      // Verify overrides are removed
      const result = config.getWorkspaceMCPOverrides("test-ws-id");
      expect(result).toBeUndefined();

      // Verify workspace still exists
      const configData = config.loadConfigOrDefault();
      const projectConfig = configData.projects.get(projectPath);
      expect(projectConfig!.workspaces[0].id).toBe("test-ws-id");
      expect(projectConfig!.workspaces[0].mcp).toBeUndefined();
    });

    it("should deduplicate disabledServers", async () => {
      const projectPath = "/fake/project";
      const workspacePath = path.join(config.srcDir, "project", "branch");

      fs.mkdirSync(workspacePath, { recursive: true });

      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, {
          workspaces: [{ path: workspacePath, id: "test-ws-id", name: "branch" }],
        });
        return cfg;
      });

      // Set with duplicates
      await config.setWorkspaceMCPOverrides("test-ws-id", {
        disabledServers: ["server-a", "server-b", "server-a"],
      });

      // Verify duplicates are removed
      const result = config.getWorkspaceMCPOverrides("test-ws-id");
      expect(result!.disabledServers).toHaveLength(2);
      expect(result!.disabledServers).toContain("server-a");
      expect(result!.disabledServers).toContain("server-b");
    });

    it("should throw error when setting overrides for non-existent workspace", async () => {
      await expect(
        config.setWorkspaceMCPOverrides("non-existent-id", { disabledServers: ["server-a"] })
      ).rejects.toThrow("Workspace non-existent-id not found in config");
    });
  });
});
