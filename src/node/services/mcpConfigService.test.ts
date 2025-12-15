import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { MCPConfigService } from "./mcpConfigService";
import { MCPServerManager } from "./mcpServerManager";
import type { WorkspaceMCPOverrides } from "@/common/types/mcp";

describe("MCP server disable filtering", () => {
  let tempDir: string;
  let configService: MCPConfigService;
  let serverManager: MCPServerManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    configService = new MCPConfigService();
    serverManager = new MCPServerManager(configService);
  });

  afterEach(async () => {
    serverManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("disabled servers are filtered from manager.listServers", async () => {
    // Add two servers
    await configService.addServer(tempDir, "enabled-server", "cmd1");
    await configService.addServer(tempDir, "disabled-server", "cmd2");

    // Disable one
    await configService.setServerEnabled(tempDir, "disabled-server", false);

    // Config service returns both (with disabled flag)
    const allServers = await configService.listServers(tempDir);
    expect(allServers).toEqual({
      "enabled-server": { command: "cmd1", disabled: false },
      "disabled-server": { command: "cmd2", disabled: true },
    });

    // Server manager filters to enabled only
    const enabledServers = await serverManager.listServers(tempDir);
    expect(enabledServers).toEqual({ "enabled-server": "cmd1" });
  });
});

describe("Workspace MCP overrides filtering", () => {
  let tempDir: string;
  let configService: MCPConfigService;
  let serverManager: MCPServerManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    configService = new MCPConfigService();
    serverManager = new MCPServerManager(configService);

    // Set up multiple servers for testing
    await configService.addServer(tempDir, "server-a", "cmd-a");
    await configService.addServer(tempDir, "server-b", "cmd-b");
    await configService.addServer(tempDir, "server-c", "cmd-c");
  });

  afterEach(async () => {
    serverManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("listServers with no overrides returns all enabled servers", async () => {
    const servers = await serverManager.listServers(tempDir);
    expect(servers).toEqual({
      "server-a": "cmd-a",
      "server-b": "cmd-b",
      "server-c": "cmd-c",
    });
  });

  test("listServers with empty overrides returns all enabled servers", async () => {
    const overrides: WorkspaceMCPOverrides = {};
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-a": "cmd-a",
      "server-b": "cmd-b",
      "server-c": "cmd-c",
    });
  });

  test("listServers with disabledServers filters out disabled servers", async () => {
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["server-a", "server-c"],
    };
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({ "server-b": "cmd-b" });
  });

  test("listServers with disabledServers removes servers not in config (no error)", async () => {
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["non-existent-server"],
    };
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-a": "cmd-a",
      "server-b": "cmd-b",
      "server-c": "cmd-c",
    });
  });

  test("enabledServers overrides project-level disabled", async () => {
    // Disable server-a at project level
    await configService.setServerEnabled(tempDir, "server-a", false);

    // Without override, server-a should be disabled
    const serversWithoutOverride = await serverManager.listServers(tempDir);
    expect(serversWithoutOverride).toEqual({
      "server-b": "cmd-b",
      "server-c": "cmd-c",
    });

    // With enabledServers override, server-a should be re-enabled
    const overrides: WorkspaceMCPOverrides = {
      enabledServers: ["server-a"],
    };
    const serversWithOverride = await serverManager.listServers(tempDir, overrides);
    expect(serversWithOverride).toEqual({
      "server-a": "cmd-a",
      "server-b": "cmd-b",
      "server-c": "cmd-c",
    });
  });

  test("project-disabled and workspace-disabled work together", async () => {
    // Disable server-a at project level
    await configService.setServerEnabled(tempDir, "server-a", false);

    // Disable server-b at workspace level
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["server-b"],
    };

    const servers = await serverManager.listServers(tempDir, overrides);
    // Only server-c should remain
    expect(servers).toEqual({ "server-c": "cmd-c" });
  });
});
