import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { Config } from "@/node/config";
import { MCPConfigService } from "./mcpConfigService";
import { MCPServerManager } from "./mcpServerManager";
import type { WorkspaceMCPOverrides } from "@/common/types/mcp";

describe("MCPConfigService", () => {
  let tempDir: string;
  let config: Config;
  let configService: MCPConfigService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    config = new Config(tempDir);
    configService = new MCPConfigService(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("writes global config to <rootDir>/mcp.jsonc", async () => {
    const result = await configService.addServer("test", {
      transport: "stdio",
      command: "echo hi",
    });
    expect(result).toEqual({ success: true, data: undefined });

    const globalPath = path.join(config.rootDir, "mcp.jsonc");
    const raw = await fs.readFile(globalPath, "utf-8");

    // Basic smoke check: file exists and contains our server name.
    expect(raw).toContain('"test"');
  });

  test("listServers merges repo overrides on top of global (override wins by name)", async () => {
    await configService.addServer("shared", {
      transport: "stdio",
      command: "global-shared",
    });

    await configService.addServer("global-only", {
      transport: "stdio",
      command: "global-only",
    });

    const projectPath = path.join(tempDir, "repo");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "mcp.jsonc"),
      `// repo override\n{\n  "servers": {\n    "shared": "repo-shared",\n    "repo-only": { "command": "repo-only", "disabled": true }\n  }\n}\n`,
      "utf-8"
    );

    const merged = await configService.listServers(projectPath);

    expect(merged).toEqual({
      shared: { transport: "stdio", command: "repo-shared", disabled: false },
      "global-only": { transport: "stdio", command: "global-only", disabled: false },
      "repo-only": { transport: "stdio", command: "repo-only", disabled: true },
    });
  });
});

describe("MCP server disable filtering", () => {
  let tempDir: string;
  let configService: MCPConfigService;
  let serverManager: MCPServerManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    const config = new Config(tempDir);

    configService = new MCPConfigService(config);
    serverManager = new MCPServerManager(configService);
  });

  afterEach(async () => {
    serverManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("disabled servers are filtered from manager.listServers", async () => {
    // Add two servers
    await configService.addServer("enabled-server", {
      transport: "stdio",
      command: "cmd1",
    });
    await configService.addServer("disabled-server", {
      transport: "stdio",
      command: "cmd2",
    });

    // Disable one
    await configService.setServerEnabled("disabled-server", false);

    // Config service returns both (with disabled flag)
    const allServers = await configService.listServers(tempDir);
    expect(allServers).toEqual({
      "enabled-server": { transport: "stdio", command: "cmd1", disabled: false },
      "disabled-server": { transport: "stdio", command: "cmd2", disabled: true },
    });

    // Server manager filters to enabled only
    const enabledServers = await serverManager.listServers(tempDir);
    expect(enabledServers).toEqual({
      "enabled-server": { transport: "stdio", command: "cmd1", disabled: false },
    });
  });
});

describe("Workspace MCP overrides filtering", () => {
  let tempDir: string;
  let configService: MCPConfigService;
  let serverManager: MCPServerManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    const config = new Config(tempDir);

    configService = new MCPConfigService(config);
    serverManager = new MCPServerManager(configService);

    // Set up multiple servers for testing
    await configService.addServer("server-a", { transport: "stdio", command: "cmd-a" });
    await configService.addServer("server-b", { transport: "stdio", command: "cmd-b" });
    await configService.addServer("server-c", { transport: "stdio", command: "cmd-c" });
  });

  afterEach(async () => {
    serverManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("listServers with no overrides returns all enabled servers", async () => {
    const servers = await serverManager.listServers(tempDir);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("listServers with empty overrides returns all enabled servers", async () => {
    const overrides: WorkspaceMCPOverrides = {};
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("listServers with disabledServers filters out disabled servers", async () => {
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["server-a", "server-c"],
    };
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
    });
  });

  test("listServers with disabledServers removes servers not in config (no error)", async () => {
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["non-existent-server"],
    };
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("enabledServers overrides project-level disabled", async () => {
    // Disable server-a at project level
    await configService.setServerEnabled("server-a", false);

    // Without override, server-a should be disabled
    const serversWithoutOverride = await serverManager.listServers(tempDir);
    expect(serversWithoutOverride).toEqual({
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });

    // With enabledServers override, server-a should be re-enabled
    const overrides: WorkspaceMCPOverrides = {
      enabledServers: ["server-a"],
    };
    const serversWithOverride = await serverManager.listServers(tempDir, overrides);
    expect(serversWithOverride).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("project-disabled and workspace-disabled work together", async () => {
    // Disable server-a at project level
    await configService.setServerEnabled("server-a", false);

    // Disable server-b at workspace level
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["server-b"],
    };

    const servers = await serverManager.listServers(tempDir, overrides);
    // Only server-c should remain
    expect(servers).toEqual({
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });
});
