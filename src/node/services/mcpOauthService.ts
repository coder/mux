import * as crypto from "crypto";
import * as http from "http";
import * as path from "path";
import * as fsPromises from "fs/promises";
import writeFileAtomic from "write-file-atomic";
import { auth, type OAuthClientProvider } from "@ai-sdk/mcp";
import type { Config } from "@/node/config";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type {
  MCPOAuthAuthStatus,
  MCPOAuthClientInformation,
  MCPOAuthStoredCredentials,
  MCPOAuthTokens,
} from "@/common/types/mcpOauth";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_DESKTOP_FLOW_TTL_MS = 60 * 1000;
const STORE_FILE_NAME = "mcp-oauth.json";

interface McpOauthStoreFileV1 {
  version: 1;
  /** projectPath -> serverName -> stored credentials */
  entries: Record<string, Record<string, MCPOAuthStoredCredentials>>;
}

function createEmptyStore(): McpOauthStoreFileV1 {
  return { version: 1, entries: {} };
}

interface BearerChallenge {
  /** The full raw WWW-Authenticate header value (best-effort). */
  raw: string;
  scope?: string;
  resourceMetadataUrl?: URL;
}

interface DesktopFlow {
  flowId: string;
  projectPath: string;
  serverName: string;
  serverUrl: string;

  authorizeUrl: string;
  redirectUri: string;

  /** Optional values discovered from WWW-Authenticate. */
  scope?: string;
  resourceMetadataUrl?: URL;

  /** PKCE verifier for this flow (set by @ai-sdk/mcp auth()). */
  codeVerifier: string | null;

  server: http.Server;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;

  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
  settled: boolean;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeProjectPathKey(projectPath: string): string {
  // Keep keys stable across callers; config already strips trailing slashes.
  return stripTrailingSlashes(projectPath);
}

function normalizeServerUrlForComparison(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);

    // Avoid accidental mismatch from an irrelevant hash.
    url.hash = "";

    // Normalize trailing slashes for comparison (treat /foo and /foo/ as equivalent).
    if (url.pathname.endsWith("/") && url.pathname !== "/") {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return null;
  }
}

function parseBearerWwwAuthenticate(header: string): BearerChallenge | null {
  const raw = header;

  // Minimal, spec-friendly extraction. We intentionally avoid implementing a full
  // RFC 7235 challenge parser; we only care about a subset of Bearer params.
  if (!/\bbearer\b/i.test(raw)) {
    return null;
  }

  const scopeMatch = raw.match(/\bscope="([^"]*)"/i) ?? raw.match(/\bscope=([^,\s]+)/i);
  const scope = scopeMatch ? scopeMatch[1] : undefined;

  const resourceMetadataMatch =
    raw.match(/\bresource_metadata="([^"]*)"/i) ?? raw.match(/\bresource_metadata=([^,\s]+)/i);

  let resourceMetadataUrl: URL | undefined;
  if (resourceMetadataMatch) {
    try {
      resourceMetadataUrl = new URL(resourceMetadataMatch[1]);
    } catch {
      // Ignore invalid URLs.
    }
  }

  return {
    raw,
    scope,
    resourceMetadataUrl,
  };
}

async function probeServerForBearerChallenge(serverUrl: string): Promise<BearerChallenge | null> {
  const normalizedUrl = normalizeServerUrlForComparison(serverUrl);
  if (!normalizedUrl) {
    return null;
  }

  // Best-effort probe: do a simple unauthenticated request and parse WWW-Authenticate.
  //
  // We intentionally avoid sending MCP-specific headers here because the probe is
  // only used to extract OAuth hints (scope/resource_metadata) and must not be
  // protocol-version coupled.
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5_000);

  try {
    const response = await fetch(normalizedUrl, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
      redirect: "manual",
      signal: abortController.signal,
    });

    const header =
      response.headers.get("www-authenticate") ?? response.headers.get("WWW-Authenticate");
    if (!header) {
      return null;
    }

    return parseBearerWwwAuthenticate(header);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseStoreFile(raw: string): McpOauthStoreFileV1 | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      return null;
    }

    const version = parsed.version;
    if (version !== 1) {
      return null;
    }

    const entriesRaw = parsed.entries;
    if (!isPlainObject(entriesRaw)) {
      return null;
    }

    const entries: Record<string, Record<string, MCPOAuthStoredCredentials>> = {};

    for (const [projectPath, byServerRaw] of Object.entries(entriesRaw)) {
      if (!isPlainObject(byServerRaw)) {
        continue;
      }

      const byServer: Record<string, MCPOAuthStoredCredentials> = {};

      for (const [serverName, credRaw] of Object.entries(byServerRaw)) {
        if (!isPlainObject(credRaw)) {
          continue;
        }

        const serverUrl = typeof credRaw.serverUrl === "string" ? credRaw.serverUrl : null;
        const updatedAtMs = typeof credRaw.updatedAtMs === "number" ? credRaw.updatedAtMs : null;

        if (!serverUrl || !updatedAtMs || !Number.isFinite(updatedAtMs)) {
          continue;
        }

        const clientInformationRaw = credRaw.clientInformation;
        const clientInformation: MCPOAuthClientInformation | undefined = isPlainObject(
          clientInformationRaw
        )
          ? {
              client_id:
                typeof clientInformationRaw.client_id === "string"
                  ? clientInformationRaw.client_id
                  : "",
              client_secret:
                typeof clientInformationRaw.client_secret === "string"
                  ? clientInformationRaw.client_secret
                  : undefined,
              client_id_issued_at:
                typeof clientInformationRaw.client_id_issued_at === "number"
                  ? clientInformationRaw.client_id_issued_at
                  : undefined,
              client_secret_expires_at:
                typeof clientInformationRaw.client_secret_expires_at === "number"
                  ? clientInformationRaw.client_secret_expires_at
                  : undefined,
            }
          : undefined;

        if (clientInformation && !clientInformation.client_id) {
          // client_id is required if the object is present.
          continue;
        }

        const tokensRaw = credRaw.tokens;
        const tokens: MCPOAuthTokens | undefined = isPlainObject(tokensRaw)
          ? {
              access_token:
                typeof tokensRaw.access_token === "string" ? tokensRaw.access_token : "",
              id_token: typeof tokensRaw.id_token === "string" ? tokensRaw.id_token : undefined,
              token_type: typeof tokensRaw.token_type === "string" ? tokensRaw.token_type : "",
              expires_in:
                typeof tokensRaw.expires_in === "number" ? tokensRaw.expires_in : undefined,
              scope: typeof tokensRaw.scope === "string" ? tokensRaw.scope : undefined,
              refresh_token:
                typeof tokensRaw.refresh_token === "string" ? tokensRaw.refresh_token : undefined,
            }
          : undefined;

        if (tokens && (!tokens.access_token || !tokens.token_type)) {
          continue;
        }

        byServer[serverName] = {
          serverUrl,
          clientInformation,
          tokens,
          updatedAtMs,
        };
      }

      if (Object.keys(byServer).length > 0) {
        entries[projectPath] = byServer;
      }
    }

    return { version: 1, entries };
  } catch {
    return null;
  }
}

export class McpOauthService {
  private readonly storeFilePath: string;
  private readonly storeLock = new MutexMap<string>();
  private store: McpOauthStoreFileV1 | null = null;

  private readonly desktopFlows = new Map<string, DesktopFlow>();

  constructor(
    private readonly config: Config,
    private readonly mcpConfigService: MCPConfigService,
    private readonly windowService?: WindowService
  ) {
    this.storeFilePath = path.join(config.rootDir, STORE_FILE_NAME);
  }

  async dispose(): Promise<void> {
    const flowIds = [...this.desktopFlows.keys()];
    await Promise.all(flowIds.map((id) => this.finishDesktopFlow(id, Err("App shutting down"))));

    for (const flow of this.desktopFlows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
    }

    this.desktopFlows.clear();
  }

  async getAuthStatus(projectPath: string, serverName: string): Promise<MCPOAuthAuthStatus> {
    const projectKey = normalizeProjectPathKey(projectPath);

    const servers = await this.mcpConfigService.listServers(projectPath);
    const server = servers[serverName];

    if (!server || server.transport === "stdio") {
      return { isLoggedIn: false, hasRefreshToken: false };
    }

    const normalizedServerUrl = normalizeServerUrlForComparison(server.url);
    if (!normalizedServerUrl) {
      return { isLoggedIn: false, hasRefreshToken: false };
    }

    const creds = await this.getValidStoredCredentials({
      projectKey,
      serverName,
      serverUrl: normalizedServerUrl,
    });

    const tokens = creds?.tokens;
    return {
      serverUrl: normalizedServerUrl,
      isLoggedIn: Boolean(tokens),
      hasRefreshToken: Boolean(tokens?.refresh_token),
      scope: tokens?.scope,
      updatedAtMs: creds?.updatedAtMs,
    };
  }

  async logout(projectPath: string, serverName: string): Promise<Result<void, string>> {
    const projectKey = normalizeProjectPathKey(projectPath);

    try {
      await this.storeLock.withLock(this.storeFilePath, async () => {
        const store = await this.ensureStoreLoadedLocked();
        const byServer = store.entries[projectKey];
        if (!byServer || !byServer[serverName]) {
          return;
        }

        delete byServer[serverName];
        if (Object.keys(byServer).length === 0) {
          delete store.entries[projectKey];
        }

        await this.persistStoreLocked(store);
      });

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(message);
    }
  }

  /**
   * Returns a provider suitable for attaching to an MCP HTTP/SSE transport.
   *
   * Critical: This must never trigger user-interactive auth in the background.
   * Therefore we only return a provider when tokens exist and we ensure
   * redirectToAuthorization never opens a browser.
   */
  async getAuthProviderForServer(input: {
    projectPath: string;
    serverName: string;
    serverUrl: string;
  }): Promise<OAuthClientProvider | undefined> {
    const projectKey = normalizeProjectPathKey(input.projectPath);
    const normalizedServerUrl = normalizeServerUrlForComparison(input.serverUrl);
    if (!normalizedServerUrl) {
      return undefined;
    }

    const creds = await this.getValidStoredCredentials({
      projectKey,
      serverName: input.serverName,
      serverUrl: normalizedServerUrl,
    });

    if (!creds?.tokens || !creds.clientInformation) {
      return undefined;
    }

    return this.createBackgroundProvider({
      projectKey,
      serverName: input.serverName,
      serverUrl: normalizedServerUrl,
    });
  }

  /**
   * Used by MCPServerManager caching to restart servers when auth state changes.
   */
  async hasAuthTokens(input: {
    projectPath: string;
    serverName: string;
    serverUrl: string;
  }): Promise<boolean> {
    const projectKey = normalizeProjectPathKey(input.projectPath);
    const normalizedServerUrl = normalizeServerUrlForComparison(input.serverUrl);
    if (!normalizedServerUrl) {
      return false;
    }

    const creds = await this.getValidStoredCredentials({
      projectKey,
      serverName: input.serverName,
      serverUrl: normalizedServerUrl,
    });

    return Boolean(creds?.tokens && creds.clientInformation);
  }

  async startDesktopFlow(input: {
    projectPath: string;
    serverName: string;
  }): Promise<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    const servers = await this.mcpConfigService.listServers(input.projectPath);
    const server = servers[input.serverName];
    if (!server) {
      return Err("MCP server not found");
    }

    if (server.transport === "stdio") {
      return Err("OAuth is only supported for remote (http/sse) MCP servers");
    }

    const normalizedServerUrl = normalizeServerUrlForComparison(server.url);
    if (!normalizedServerUrl) {
      return Err("Invalid MCP server URL");
    }

    const projectKey = normalizeProjectPathKey(input.projectPath);

    const flowId = crypto.randomUUID();
    const { promise: resultPromise, resolve: resolveResult } =
      createDeferred<Result<void, string>>();

    const serverListener = http.createServer((req, res) => {
      const reqUrl = req.url ?? "/";
      const url = new URL(reqUrl, "http://localhost");

      if (req.method !== "GET" || url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const state = url.searchParams.get("state");
      if (!state || state !== flowId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html");
        res.end("<h1>Invalid OAuth state</h1>");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description") ?? undefined;

      void this.handleDesktopCallback({
        flowId,
        serverUrl: normalizedServerUrl,
        code,
        error,
        errorDescription,
        res,
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        serverListener.once("error", reject);
        serverListener.listen(0, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to start OAuth callback listener: ${message}`);
    }

    const address = serverListener.address();
    if (!address || typeof address === "string") {
      return Err("Failed to determine OAuth callback listener port");
    }

    const redirectUri = `http://127.0.0.1:${address.port}/callback`;

    // Best-effort probe for OAuth hints (scope/resource_metadata). If it fails,
    // @ai-sdk/mcp can still fall back to well-known discovery.
    const challenge = await probeServerForBearerChallenge(normalizedServerUrl);

    const flow: DesktopFlow = {
      flowId,
      projectPath: projectKey,
      serverName: input.serverName,
      serverUrl: normalizedServerUrl,
      authorizeUrl: "",
      redirectUri,
      scope: challenge?.scope,
      resourceMetadataUrl: challenge?.resourceMetadataUrl,
      codeVerifier: null,
      server: serverListener,
      timeout: setTimeout(() => {
        void this.finishDesktopFlow(flowId, Err("Timed out waiting for OAuth callback"));
      }, DEFAULT_DESKTOP_TIMEOUT_MS),
      cleanupTimeout: null,
      resultPromise,
      resolveResult,
      settled: false,
    };

    try {
      // Force a user-interactive flow by not exposing existing tokens.
      const provider = this.createDesktopFlowProvider(flow);

      const result = await auth(provider, {
        serverUrl: normalizedServerUrl,
        scope: flow.scope,
        resourceMetadataUrl: flow.resourceMetadataUrl,
      });

      if (result !== "REDIRECT" || !flow.authorizeUrl) {
        return Err("Failed to start OAuth authorization");
      }

      this.desktopFlows.set(flowId, flow);

      log.debug("[MCP OAuth] Desktop flow started", {
        flowId,
        projectPath: projectKey,
        serverName: input.serverName,
      });

      return Ok({ flowId, authorizeUrl: flow.authorizeUrl, redirectUri });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ensure listener is cleaned up if auth setup fails.
      await closeServer(serverListener).catch(() => undefined);
      return Err(message);
    }
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow) {
      return Err("OAuth flow not found");
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<void, string>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(Err("Timed out waiting for OAuth callback"));
      }, timeoutMs);
    });

    const result = await Promise.race([flow.resultPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      void this.finishDesktopFlow(flowId, result);
    }

    return result;
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow) return;

    log.debug("[MCP OAuth] Desktop flow cancelled", { flowId });
    await this.finishDesktopFlow(flowId, Err("OAuth flow cancelled"));
  }

  private createDesktopFlowProvider(flow: DesktopFlow): OAuthClientProvider {
    return {
      tokens: async () => undefined,
      saveTokens: async (tokens) => {
        await this.saveTokens({
          projectKey: flow.projectPath,
          serverName: flow.serverName,
          serverUrl: flow.serverUrl,
          tokens: tokens as unknown as MCPOAuthTokens,
        });
      },
      redirectToAuthorization: async (authorizationUrl) => {
        flow.authorizeUrl = authorizationUrl.toString();
      },
      saveCodeVerifier: async (codeVerifier) => {
        flow.codeVerifier = codeVerifier;
      },
      codeVerifier: async () => {
        if (!flow.codeVerifier) {
          throw new Error("Missing PKCE code verifier");
        }
        return flow.codeVerifier;
      },
      invalidateCredentials: async (scope) => {
        await this.invalidateStoredCredentials({
          projectKey: flow.projectPath,
          serverName: flow.serverName,
          scope,
        });
      },
      get redirectUrl() {
        return flow.redirectUri;
      },
      get clientMetadata() {
        return {
          redirect_uris: [flow.redirectUri],
          response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
          client_name: "Mux MCP",
          scope: flow.scope,
        };
      },
      clientInformation: async () => {
        const creds = await this.getValidStoredCredentials({
          projectKey: flow.projectPath,
          serverName: flow.serverName,
          serverUrl: flow.serverUrl,
        });
        return creds?.clientInformation as unknown as MCPOAuthClientInformation | undefined;
      },
      saveClientInformation: async (clientInformation) => {
        await this.saveClientInformation({
          projectKey: flow.projectPath,
          serverName: flow.serverName,
          serverUrl: flow.serverUrl,
          clientInformation: clientInformation as unknown as MCPOAuthClientInformation,
        });
      },
      state: async () => flow.flowId,
    };
  }

  private createBackgroundProvider(input: {
    projectKey: string;
    serverName: string;
    serverUrl: string;
  }): OAuthClientProvider {
    return {
      tokens: async () => {
        const creds = await this.getValidStoredCredentials({
          projectKey: input.projectKey,
          serverName: input.serverName,
          serverUrl: input.serverUrl,
        });
        return creds?.tokens as unknown as MCPOAuthTokens | undefined;
      },
      saveTokens: async (tokens) => {
        await this.saveTokens({
          projectKey: input.projectKey,
          serverName: input.serverName,
          serverUrl: input.serverUrl,
          tokens: tokens as unknown as MCPOAuthTokens,
        });
      },
      redirectToAuthorization: async () => {
        // Avoid any user-visible side effects during background tool calls.
        // If we end up here, the server requires interactive auth.
        await this.invalidateStoredCredentials({
          projectKey: input.projectKey,
          serverName: input.serverName,
          scope: "tokens",
        });
        throw new Error("MCP OAuth login required");
      },
      saveCodeVerifier: async () => {
        // Background providers never start interactive flows.
      },
      codeVerifier: async () => {
        throw new Error("PKCE verifier is not available");
      },
      invalidateCredentials: async (scope) => {
        await this.invalidateStoredCredentials({
          projectKey: input.projectKey,
          serverName: input.serverName,
          scope,
        });
      },
      get redirectUrl() {
        // Unused in background mode.
        return "http://127.0.0.1/";
      },
      get clientMetadata() {
        // Unused in background mode; must still be present for the interface.
        return {
          redirect_uris: ["http://127.0.0.1/"],
        };
      },
      clientInformation: async () => {
        const creds = await this.getValidStoredCredentials({
          projectKey: input.projectKey,
          serverName: input.serverName,
          serverUrl: input.serverUrl,
        });
        return creds?.clientInformation as unknown as MCPOAuthClientInformation | undefined;
      },
      saveClientInformation: async (clientInformation) => {
        await this.saveClientInformation({
          projectKey: input.projectKey,
          serverName: input.serverName,
          serverUrl: input.serverUrl,
          clientInformation: clientInformation as unknown as MCPOAuthClientInformation,
        });
      },
    };
  }

  private async handleDesktopCallback(input: {
    flowId: string;
    serverUrl: string;
    code: string | null;
    error: string | null;
    errorDescription?: string;
    res: http.ServerResponse;
  }): Promise<void> {
    const flow = this.desktopFlows.get(input.flowId);
    if (!flow || flow.settled) {
      input.res.statusCode = 409;
      input.res.setHeader("Content-Type", "text/html");
      input.res.end("<h1>OAuth flow already completed</h1>");
      return;
    }

    log.debug("[MCP OAuth] Callback received", { flowId: input.flowId });

    const result = await this.exchangeAuthorizationCode(flow, {
      code: input.code,
      error: input.error,
      errorDescription: input.errorDescription,
    });

    const title = result.success ? "Login complete" : "Login failed";
    const description = result.success
      ? "You can return to Mux. You may now close this tab."
      : escapeHtml(result.error);

    input.res.setHeader("Content-Type", "text/html");
    if (!result.success) {
      input.res.statusCode = 400;
    }

    input.res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${description}</p>
  </body>
</html>`);

    await this.finishDesktopFlow(input.flowId, result);
  }

  private async exchangeAuthorizationCode(
    flow: DesktopFlow,
    input: { code: string | null; error: string | null; errorDescription?: string }
  ): Promise<Result<void, string>> {
    if (input.error) {
      const message = input.errorDescription
        ? `${input.error}: ${input.errorDescription}`
        : input.error;
      return Err(`MCP OAuth error: ${message}`);
    }

    if (!input.code) {
      return Err("Missing OAuth code");
    }

    try {
      const provider = this.createDesktopFlowProvider(flow);

      const result = await auth(provider, {
        serverUrl: flow.serverUrl,
        authorizationCode: input.code,
        scope: flow.scope,
        resourceMetadataUrl: flow.resourceMetadataUrl,
      });

      if (result !== "AUTHORIZED") {
        return Err("OAuth exchange did not complete");
      }

      this.windowService?.focusMainWindow();

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(message);
    }
  }

  private async finishDesktopFlow(flowId: string, result: Result<void, string>): Promise<void> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow || flow.settled) return;

    flow.settled = true;
    clearTimeout(flow.timeout);

    try {
      flow.resolveResult(result);

      await closeServer(flow.server);
    } catch (error) {
      log.debug("[MCP OAuth] Failed to close OAuth callback listener", { error });
    } finally {
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
      flow.cleanupTimeout = setTimeout(() => {
        this.desktopFlows.delete(flowId);
      }, COMPLETED_DESKTOP_FLOW_TTL_MS);
    }
  }

  private async getValidStoredCredentials(input: {
    projectKey: string;
    serverName: string;
    serverUrl: string;
  }): Promise<MCPOAuthStoredCredentials | null> {
    await this.ensureStoreLoaded();
    const store = this.store;
    if (!store) {
      return null;
    }

    const byServer = store.entries[input.projectKey];
    const creds = byServer?.[input.serverName];
    if (!creds) {
      return null;
    }

    // Defensive: If the configured server URL changes, invalidate stored creds.
    const storedUrl = normalizeServerUrlForComparison(creds.serverUrl);
    if (!storedUrl || storedUrl !== input.serverUrl) {
      await this.logout(input.projectKey, input.serverName);
      return null;
    }

    return creds;
  }

  private async invalidateStoredCredentials(input: {
    projectKey: string;
    serverName: string;
    scope: "all" | "client" | "tokens" | "verifier";
  }): Promise<void> {
    await this.storeLock.withLock(this.storeFilePath, async () => {
      const store = await this.ensureStoreLoadedLocked();
      const byServer = store.entries[input.projectKey];
      const creds = byServer?.[input.serverName];
      if (!creds) {
        return;
      }

      if (input.scope === "tokens" || input.scope === "all") {
        creds.tokens = undefined;
      }

      if (input.scope === "client" || input.scope === "all") {
        creds.clientInformation = undefined;
      }

      // verifier is per-flow (in-memory) only.

      creds.updatedAtMs = Date.now();

      // If everything is gone, prune the entry.
      if (!creds.tokens && !creds.clientInformation) {
        delete byServer[input.serverName];
        if (Object.keys(byServer).length === 0) {
          delete store.entries[input.projectKey];
        }
      }

      await this.persistStoreLocked(store);
    });
  }

  private async saveTokens(input: {
    projectKey: string;
    serverName: string;
    serverUrl: string;
    tokens: MCPOAuthTokens;
  }): Promise<void> {
    await this.storeLock.withLock(this.storeFilePath, async () => {
      const store = await this.ensureStoreLoadedLocked();
      const byServer = (store.entries[input.projectKey] ??= {});
      const creds = (byServer[input.serverName] ??= {
        serverUrl: input.serverUrl,
        updatedAtMs: Date.now(),
      });

      // Defensive: Never keep tokens bound to a different URL.
      if (normalizeServerUrlForComparison(creds.serverUrl) !== input.serverUrl) {
        creds.clientInformation = undefined;
      }

      creds.serverUrl = input.serverUrl;
      creds.tokens = input.tokens;
      creds.updatedAtMs = Date.now();

      await this.persistStoreLocked(store);
    });
  }

  private async saveClientInformation(input: {
    projectKey: string;
    serverName: string;
    serverUrl: string;
    clientInformation: MCPOAuthClientInformation;
  }): Promise<void> {
    await this.storeLock.withLock(this.storeFilePath, async () => {
      const store = await this.ensureStoreLoadedLocked();
      const byServer = (store.entries[input.projectKey] ??= {});
      const creds = (byServer[input.serverName] ??= {
        serverUrl: input.serverUrl,
        updatedAtMs: Date.now(),
      });

      // Defensive: Never keep client info bound to a different URL.
      if (normalizeServerUrlForComparison(creds.serverUrl) !== input.serverUrl) {
        creds.tokens = undefined;
      }

      creds.serverUrl = input.serverUrl;
      creds.clientInformation = input.clientInformation;
      creds.updatedAtMs = Date.now();

      await this.persistStoreLocked(store);
    });
  }

  private async ensureStoreLoaded(): Promise<void> {
    if (this.store) {
      return;
    }

    await this.storeLock.withLock(this.storeFilePath, async () => {
      await this.ensureStoreLoadedLocked();
    });
  }

  private async ensureStoreLoadedLocked(): Promise<McpOauthStoreFileV1> {
    if (this.store) {
      return this.store;
    }

    try {
      const raw = await fsPromises.readFile(this.storeFilePath, "utf-8");
      const parsed = parseStoreFile(raw);
      if (!parsed) {
        log.warn("[MCP OAuth] Invalid store file; resetting", { filePath: this.storeFilePath });
        this.store = createEmptyStore();
        await this.persistStoreLocked(this.store);
        return this.store;
      }

      this.store = parsed;
      return parsed;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.store = createEmptyStore();
        return this.store;
      }

      log.warn("[MCP OAuth] Failed to read store file; resetting", { error });
      this.store = createEmptyStore();
      await this.persistStoreLocked(this.store);
      return this.store;
    }
  }

  private async persistStoreLocked(store: McpOauthStoreFileV1): Promise<void> {
    // Ensure ~/.mux exists.
    await fsPromises.mkdir(this.config.rootDir, { recursive: true });

    await writeFileAtomic(this.storeFilePath, JSON.stringify(store, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
