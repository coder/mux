import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "http";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { MCPConfigService } from "./mcpConfigService";
import {
  McpOauthService,
  parseBearerWwwAuthenticate,
  probeServerForBearerChallenge,
  resolveOAuthScope,
} from "./mcpOauthService";

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
    mcpConfigService = new MCPConfigService(config);
    service = new McpOauthService(config, mcpConfigService);

    const addResult = await mcpConfigService.addServer(serverName, {
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

    const status = await service.getAuthStatus({ serverUrl });
    expect(status).toEqual({
      serverUrl: "https://example.com/",
      isLoggedIn: false,
      hasRefreshToken: false,
      scope: undefined,
      updatedAtMs: undefined,
    });

    // The invalid store file should be overwritten with a minimal empty store.
    expect(await readStoreFile()).toEqual({ version: 2, entries: {} });
  });

  test("migrates v1 store to v2 (dedupes by updatedAtMs)", async () => {
    const otherProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-project2-"));

    try {
      const v1Store = {
        version: 1,
        entries: {
          [projectPath]: {
            // Older duplicate for the same server URL.
            [serverName]: {
              serverUrl,
              updatedAtMs: 1_000,
              clientInformation: {
                client_id: "client-id-old",
              },
              tokens: {
                access_token: "access-token-old",
                token_type: "Bearer",
                refresh_token: "refresh-token-old",
              },
            },
            // Newer duplicate for the same server URL.
            duplicate: {
              serverUrl,
              updatedAtMs: 2_000,
              clientInformation: {
                client_id: "client-id-new",
              },
              tokens: {
                access_token: "access-token-new",
                token_type: "Bearer",
                refresh_token: "refresh-token-new",
              },
            },
          },
          [otherProjectPath]: {
            other: {
              serverUrl: "https://other.example.com/mcp/",
              updatedAtMs: 1_500,
              clientInformation: {
                client_id: "client-id-other",
              },
              tokens: {
                access_token: "access-token-other",
                token_type: "Bearer",
              },
            },
          },
        },
      };

      await fs.writeFile(getStoreFilePath(muxHome), JSON.stringify(v1Store), "utf-8");

      // Trigger store load + migration.
      await service.getAuthStatus({ serverUrl });

      expect(await readStoreFile()).toEqual({
        version: 2,
        entries: {
          "https://example.com/": {
            serverUrl: "https://example.com/",
            updatedAtMs: 2_000,
            clientInformation: {
              client_id: "client-id-new",
            },
            tokens: {
              access_token: "access-token-new",
              token_type: "Bearer",
              refresh_token: "refresh-token-new",
            },
          },
          "https://other.example.com/mcp": {
            serverUrl: "https://other.example.com/mcp",
            updatedAtMs: 1_500,
            clientInformation: {
              client_id: "client-id-other",
            },
            tokens: {
              access_token: "access-token-other",
              token_type: "Bearer",
            },
          },
        },
      });
    } finally {
      await fs.rm(otherProjectPath, { recursive: true, force: true });
    }
  });

  test("set/get/clear works via hasAuthTokens + logout", async () => {
    const populatedStore = {
      version: 2,
      entries: {
        "https://example.com/": {
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
    };
    await fs.writeFile(getStoreFilePath(muxHome), JSON.stringify(populatedStore), "utf-8");

    expect(
      await service.hasAuthTokens({
        serverUrl,
      })
    ).toBe(true);

    const status = await service.getAuthStatus({ serverUrl });
    expect(typeof status.updatedAtMs).toBe("number");
    expect(status).toEqual({
      serverUrl: "https://example.com/",
      isLoggedIn: true,
      hasRefreshToken: true,
      scope: "mcp.read",
      updatedAtMs: status.updatedAtMs,
    });

    const logoutResult = await service.logout({ serverUrl });
    expect(logoutResult).toEqual({ success: true, data: undefined });

    expect(
      await service.hasAuthTokens({
        serverUrl,
      })
    ).toBe(false);

    expect(await readStoreFile()).toEqual({ version: 2, entries: {} });
  });

  // Regression test: @ai-sdk/mcp auth() only uses a stored refresh_token when
  // the persisted tokens/clientInformation retain the authorization_server +
  // token_endpoint binding it saved. Stripping them during store parsing made
  // auth() invalidate the tokens and demand interactive re-login after every
  // app restart.
  test("authorization server binding survives store round-trip", async () => {
    const populatedStore = {
      version: 2,
      entries: {
        "https://example.com/": {
          serverUrl,
          updatedAtMs: Date.now(),
          clientInformation: {
            client_id: "client-id",
            authorization_server: "https://auth.example.com/",
            token_endpoint: "https://auth.example.com/token",
          },
          tokens: {
            access_token: "access-token",
            token_type: "Bearer",
            refresh_token: "refresh-token",
            authorization_server: "https://auth.example.com/",
            token_endpoint: "https://auth.example.com/token",
          },
        },
      },
    };
    await fs.writeFile(getStoreFilePath(muxHome), JSON.stringify(populatedStore), "utf-8");

    const provider = await service.getAuthProviderForServer({ serverUrl });
    expect(provider).toBeDefined();

    const tokens = await provider!.tokens();
    expect(tokens?.refresh_token).toBe("refresh-token");
    expect(tokens?.authorization_server).toBe("https://auth.example.com/");
    expect(tokens?.token_endpoint).toBe("https://auth.example.com/token");

    const clientInformation = await provider!.clientInformation();
    expect(clientInformation?.authorization_server).toBe("https://auth.example.com/");
    expect(clientInformation?.token_endpoint).toBe("https://auth.example.com/token");
  });

  test.each([
    // Corrupted: not a parseable URL.
    "not a url",
    // Parseable but rejected by @ai-sdk/mcp's SafeUrlSchema; must be dropped
    // for self-healing rather than surfacing as a metadata mismatch in auth().
    "javascript:alert(1)",
    "data:text/plain,x",
    "vbscript:x",
    // Parseable non-http(s) scheme: OAuth endpoints are always http(s).
    "ftp://auth.example.com/",
  ])("invalid authorization server binding %j is dropped as a pair", async (badUrl) => {
    const populatedStore = {
      version: 2,
      entries: {
        "https://example.com/": {
          serverUrl,
          updatedAtMs: Date.now(),
          clientInformation: { client_id: "client-id" },
          tokens: {
            access_token: "access-token",
            token_type: "Bearer",
            refresh_token: "refresh-token",
            authorization_server: badUrl,
            token_endpoint: "https://auth.example.com/token",
          },
        },
      },
    };
    await fs.writeFile(getStoreFilePath(muxHome), JSON.stringify(populatedStore), "utf-8");

    const provider = await service.getAuthProviderForServer({ serverUrl });
    expect(provider).toBeDefined();

    const tokens = await provider!.tokens();
    expect(tokens?.refresh_token).toBe("refresh-token");
    expect(tokens?.authorization_server).toBeUndefined();
    expect(tokens?.token_endpoint).toBeUndefined();
  });
});

describe("parseBearerWwwAuthenticate", () => {
  test("extracts scope and resource_metadata", () => {
    const header =
      'Bearer realm="example", scope="mcp.read mcp.write", resource_metadata="https://example.com/.well-known/oauth-protected-resource"';

    const challenge = parseBearerWwwAuthenticate(header);
    expect(challenge).not.toBeNull();
    expect(challenge?.scope).toBe("mcp.read mcp.write");
    expect(challenge?.resourceMetadataUrl?.toString()).toBe(
      "https://example.com/.well-known/oauth-protected-resource"
    );
  });

  test("extracts unquoted scope and resource_metadata", () => {
    const header =
      "Bearer scope=mcp.read resource_metadata=http://example.com/.well-known/oauth-protected-resource";

    const challenge = parseBearerWwwAuthenticate(header);
    expect(challenge).not.toBeNull();
    expect(challenge?.scope).toBe("mcp.read");
    expect(challenge?.resourceMetadataUrl?.toString()).toBe(
      "http://example.com/.well-known/oauth-protected-resource"
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

describe("probeServerForBearerChallenge", () => {
  test("prefers POST for http servers that reject GET", async () => {
    let resourceMetadataUrl = "";
    const seenMethods: string[] = [];

    const server = createServer((req, res) => {
      seenMethods.push(req.method ?? "UNKNOWN");
      res.statusCode = req.method === "POST" ? 401 : 405;
      if (req.method === "POST") {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
        );
      }
      res.end(req.method === "POST" ? "Unauthorized" : "Method Not Allowed");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind probe test server");
      }

      const baseUrl = `http://127.0.0.1:${address.port}/mcp`;
      resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

      const challenge = await probeServerForBearerChallenge({
        serverUrl: baseUrl,
        transport: "http",
      });

      expect(challenge).toMatchObject({
        raw: `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`,
        scope: "mcp.read",
      });
      expect(challenge?.resourceMetadataUrl?.toString()).toBe(resourceMetadataUrl);
      expect(seenMethods).toEqual(["POST"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("falls back to GET for auto servers when POST has no challenge", async () => {
    let resourceMetadataUrl = "";
    const seenMethods: string[] = [];

    const server = createServer((req, res) => {
      seenMethods.push(req.method ?? "UNKNOWN");
      if (req.method === "POST") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }

      res.statusCode = 401;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
      );
      res.end("Unauthorized");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind auto probe test server");
      }

      const baseUrl = `http://127.0.0.1:${address.port}/mcp`;
      resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

      const challenge = await probeServerForBearerChallenge({
        serverUrl: baseUrl,
        transport: "auto",
      });

      expect(challenge).toMatchObject({
        raw: `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`,
        scope: "mcp.read",
      });
      expect(challenge?.resourceMetadataUrl?.toString()).toBe(resourceMetadataUrl);
      expect(seenMethods).toEqual(["POST", "GET"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("McpOauthService.startDesktopFlow", () => {
  let muxHome: string;
  let projectPath: string;
  let config: Config;
  let mcpConfigService: MCPConfigService;
  let service: McpOauthService;

  beforeEach(async () => {
    muxHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-home-"));
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-flow-project-"));

    config = new Config(muxHome);
    mcpConfigService = new MCPConfigService(config);
    service = new McpOauthService(config, mcpConfigService);
  });

  afterEach(async () => {
    await service.dispose();
    await fs.rm(muxHome, { recursive: true, force: true });
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  test("generates an authorizeUrl with PKCE S256 + RFC 8707 resource", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";

    const server = createServer((req, res) => {
      void (async () => {
        const pathname = (req.url ?? "/").split("?")[0];

        if (pathname === "/.well-known/oauth-protected-resource") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              resource: baseUrl,
              authorization_servers: [baseUrl],
            })
          );
          return;
        }

        if (pathname === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              // RFC 8414 canonical issuer: no trailing slash at the root.
              // @ai-sdk/mcp v2 strictly validates metadata issuer identity.
              issuer: new URL(baseUrl).origin,
              authorization_endpoint: `${baseUrl}authorize`,
              token_endpoint: `${baseUrl}token`,
              registration_endpoint: `${baseUrl}register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            })
          );
          return;
        }

        if (pathname === "/register") {
          let raw = "";
          for await (const chunk of req) {
            raw += Buffer.from(chunk as Uint8Array).toString("utf-8");
          }

          const clientMetadata = JSON.parse(raw) as Record<string, unknown>;

          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ...clientMetadata,
              client_id: "test-client-id",
            })
          );
          return;
        }

        // Default: act like an MCP server requiring OAuth.
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
        );
        res.end("Unauthorized");
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind OAuth test server");
      }

      baseUrl = `http://127.0.0.1:${address.port}/`;
      resourceMetadataUrl = `${baseUrl}.well-known/oauth-protected-resource`;

      const serverName = "oauth-server";

      const addResult = await mcpConfigService.addServer(serverName, {
        transport: "http",
        url: baseUrl,
      });
      expect(addResult).toEqual({ success: true, data: undefined });

      const startResult = await service.startDesktopFlow({ projectPath, serverName });
      expect(startResult.success).toBe(true);
      if (!startResult.success) {
        throw new Error(startResult.error);
      }

      const authorizeUrl = new URL(startResult.data.authorizeUrl);
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      // OAuth providers may canonicalize a root resource URL to its origin. That is
      // equivalent to the configured root server URL, while base-path URLs are covered below.
      expect(authorizeUrl.searchParams.get("resource")).toBe(new URL(baseUrl).origin);

      // Clean up the loopback listener (no callback will occur during this test).
      await service.cancelDesktopFlow(startResult.data.flowId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("preserves trailing slashes for OAuth discovery under a base path", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";
    let authorizationServerBaseUrl = "";
    const seenPaths: string[] = [];

    const server = createServer((req, res) => {
      void (async () => {
        const pathname = (req.url ?? "/").split("?")[0];
        seenPaths.push(pathname);

        if (pathname === "/.well-known/oauth-authorization-server") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              // RFC 8414 canonical issuer: no trailing slash at the root.
              // @ai-sdk/mcp v2 strictly validates metadata issuer identity.
              issuer: new URL(authorizationServerBaseUrl).origin,
              authorization_endpoint: `${authorizationServerBaseUrl}authorize`,
              token_endpoint: `${authorizationServerBaseUrl}token`,
              registration_endpoint: `${authorizationServerBaseUrl}register`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            })
          );
          return;
        }

        if (pathname === "/register") {
          let raw = "";
          for await (const chunk of req) {
            raw += Buffer.from(chunk as Uint8Array).toString("utf-8");
          }

          const clientMetadata = JSON.parse(raw) as Record<string, unknown>;

          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ...clientMetadata,
              client_id: "test-client-id",
            })
          );
          return;
        }

        if (pathname === "/mcp/.well-known/oauth-protected-resource") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              resource: baseUrl,
              authorization_servers: [authorizationServerBaseUrl],
            })
          );
          return;
        }

        if (pathname === "/mcp/") {
          // Default: act like an MCP server requiring OAuth.
          res.statusCode = 401;
          res.setHeader(
            "WWW-Authenticate",
            `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
          );
          res.end("Unauthorized");
          return;
        }

        // Anything outside of the configured /mcp/ base path should not be used.
        res.statusCode = 404;
        res.end("Not found");
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind OAuth test server");
      }

      authorizationServerBaseUrl = `http://127.0.0.1:${address.port}/`;
      baseUrl = `${authorizationServerBaseUrl}mcp/`;
      resourceMetadataUrl = `${baseUrl}.well-known/oauth-protected-resource`;

      const serverName = "oauth-server-trailing-slash";

      const addResult = await mcpConfigService.addServer(serverName, {
        transport: "http",
        url: baseUrl,
      });
      expect(addResult).toEqual({ success: true, data: undefined });

      const startResult = await service.startDesktopFlow({ projectPath, serverName });
      expect(startResult.success).toBe(true);
      if (!startResult.success) {
        throw new Error(startResult.error);
      }

      const authorizeUrl = new URL(startResult.data.authorizeUrl);
      expect(authorizeUrl.searchParams.get("resource")).toBe(baseUrl);

      // Ensure we hit the configured /mcp/ path (trailing slash required) and its resource_metadata.
      expect(seenPaths).toContain("/mcp/");
      expect(seenPaths).toContain("/mcp/.well-known/oauth-protected-resource");

      // Stored credentials should continue to use a normalized URL for keying.
      const storeRaw = await fs.readFile(getStoreFilePath(muxHome), "utf-8");
      const serverUrlKey = baseUrl.slice(0, -1);
      expect(JSON.parse(storeRaw)).toMatchObject({
        version: 2,
        entries: {
          [serverUrlKey]: {
            serverUrl: serverUrlKey,
          },
        },
      });

      // Clean up the loopback listener (no callback will occur during this test).
      await service.cancelDesktopFlow(startResult.data.flowId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("resolveOAuthScope", () => {
  async function startMetadataServer(
    body: unknown
  ): Promise<{ url: URL; close: () => Promise<void> }> {
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind metadata server");
    }
    return {
      url: new URL(`http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource`),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  test("uses the challenge scope when present", async () => {
    expect(await resolveOAuthScope({ raw: "", scope: "mcp.read" })).toBe("mcp.read");
  });

  test("falls back to all advertised PRM scopes when the challenge omits scope", async () => {
    // Carta advertises read_* and readwrite_* scopes but omits scope= from its
    // 401. Cap-table reads require the readwrite_* scopes, so request every
    // advertised scope rather than dropping readwrite_* as redundant.
    const metadata = await startMetadataServer({
      scopes_supported: ["openid", "cuid", "read_mcp_companies", "readwrite_mcp_companies"],
    });
    try {
      expect(await resolveOAuthScope({ raw: "", resourceMetadataUrl: metadata.url })).toBe(
        "openid cuid read_mcp_companies readwrite_mcp_companies"
      );
    } finally {
      await metadata.close();
    }
  });

  test("returns undefined when PRM advertises no scopes", async () => {
    const metadata = await startMetadataServer({ resource: "https://example.com" });
    try {
      expect(
        await resolveOAuthScope({ raw: "", resourceMetadataUrl: metadata.url })
      ).toBeUndefined();
    } finally {
      await metadata.close();
    }
  });
});
