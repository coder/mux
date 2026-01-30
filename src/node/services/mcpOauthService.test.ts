import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { MCPConfigService } from "./mcpConfigService";
import { McpOauthService, parseBearerWwwAuthenticate } from "./mcpOauthService";

function getStoreFilePath(muxHome: string): string {
  return path.join(muxHome, "mcp-oauth.json");
}

describe("McpOauthService store", () => {
  let muxHome: string;
  let projectPath: string;
  let config: Config;
  let mcpConfigService: MCPConfigService;
  let service: McpOauthService;

  const serverName = "test-server";
  const serverUrl = "https://example.com";

  beforeEach(async () => {
    muxHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-home-"));
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-project-"));

    config = new Config(muxHome);
    mcpConfigService = new MCPConfigService();
    service = new McpOauthService(config, mcpConfigService);

    const addResult = await mcpConfigService.addServer(projectPath, serverName, {
      transport: "http",
      url: serverUrl,
    });
    expect(addResult).toEqual({ success: true, data: undefined });
  });

  afterEach(async () => {
    await service.dispose();
    await fs.rm(muxHome, { recursive: true, force: true });
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  async function readStoreFile(): Promise<unknown> {
    const raw = await fs.readFile(getStoreFilePath(muxHome), "utf-8");
    return JSON.parse(raw) as unknown;
  }

  test("reading corrupt JSON store self-heals to empty", async () => {
    await fs.writeFile(getStoreFilePath(muxHome), "{ definitely not valid json", "utf-8");

    const status = await service.getAuthStatus(projectPath, serverName);
    expect(status).toEqual({
      serverUrl: "https://example.com/",
      isLoggedIn: false,
      hasRefreshToken: false,
      scope: undefined,
      updatedAtMs: undefined,
    });

    // The invalid store file should be overwritten with a minimal empty store.
    expect(await readStoreFile()).toEqual({ version: 1, entries: {} });
  });

  test("mismatched serverUrl invalidates stored credentials", async () => {
    const mismatchedStore = {
      version: 1,
      entries: {
        [projectPath]: {
          [serverName]: {
            serverUrl: "https://other.example.com",
            updatedAtMs: Date.now(),
            clientInformation: {
              client_id: "client-id",
            },
            tokens: {
              access_token: "access-token",
              token_type: "Bearer",
              refresh_token: "refresh-token",
            },
          },
        },
      },
    };
    await fs.writeFile(getStoreFilePath(muxHome), JSON.stringify(mismatchedStore), "utf-8");

    const status = await service.getAuthStatus(projectPath, serverName);
    expect(status.isLoggedIn).toBe(false);

    // Defensive behavior: a URL mismatch should clear the stored entry so we don't
    // accidentally reuse credentials from a different server.
    expect(await readStoreFile()).toEqual({ version: 1, entries: {} });
  });

  test("set/get/clear works via hasAuthTokens + logout", async () => {
    const populatedStore = {
      version: 1,
      entries: {
        [projectPath]: {
          [serverName]: {
            serverUrl,
            updatedAtMs: Date.now(),
            clientInformation: {
              client_id: "client-id",
            },
            tokens: {
              access_token: "access-token",
              token_type: "Bearer",
              refresh_token: "refresh-token",
              scope: "mcp.read",
            },
          },
        },
      },
    };
    await fs.writeFile(getStoreFilePath(muxHome), JSON.stringify(populatedStore), "utf-8");

    expect(
      await service.hasAuthTokens({
        projectPath,
        serverName,
        serverUrl,
      })
    ).toBe(true);

    const status = await service.getAuthStatus(projectPath, serverName);
    expect(status).toEqual({
      serverUrl: "https://example.com/",
      isLoggedIn: true,
      hasRefreshToken: true,
      scope: "mcp.read",
      updatedAtMs: expect.any(Number),
    });

    const logoutResult = await service.logout(projectPath, serverName);
    expect(logoutResult).toEqual({ success: true, data: undefined });

    expect(
      await service.hasAuthTokens({
        projectPath,
        serverName,
        serverUrl,
      })
    ).toBe(false);

    expect(await readStoreFile()).toEqual({ version: 1, entries: {} });
  });
});

describe("parseBearerWwwAuthenticate", () => {
  test("extracts scope and resource_metadata", () => {
    const header =
      'Bearer realm="example", scope="mcp.read mcp.write", resource_metadata="https://example.com/.well-known/oauth-authorization-server"';

    const challenge = parseBearerWwwAuthenticate(header);
    expect(challenge).not.toBeNull();
    expect(challenge?.scope).toBe("mcp.read mcp.write");
    expect(challenge?.resourceMetadataUrl?.toString()).toBe(
      "https://example.com/.well-known/oauth-authorization-server"
    );
  });

  test("returns null for non-bearer challenges", () => {
    expect(parseBearerWwwAuthenticate('Basic realm="example"')).toBeNull();
  });

  test("ignores invalid resource_metadata URLs", () => {
    const header = 'Bearer scope="mcp.read" resource_metadata="not a url"';

    const challenge = parseBearerWwwAuthenticate(header);
    expect(challenge).not.toBeNull();
    expect(challenge?.scope).toBe("mcp.read");
    expect(challenge?.resourceMetadataUrl).toBeUndefined();
  });
});
