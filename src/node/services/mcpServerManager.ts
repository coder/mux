import { experimental_createMCPClient } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { log } from "@/node/services/log";
import { MCPStdioTransport } from "@/node/services/mcpStdioTransport";
import type {
  MCPHeaderValue,
  MCPServerInfo,
  MCPServerMap,
  MCPServerTransport,
  MCPTestResult,
  WorkspaceMCPOverrides,
} from "@/common/types/mcp";
import type { Runtime } from "@/node/runtime/Runtime";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { transformMCPResult, type MCPCallToolResult } from "@/node/services/mcpResultTransform";

const TEST_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

/**
 * Wrap MCP tools to transform their results to AI SDK format.
 * This ensures image content is properly converted to media type.
 */
function wrapMCPTools(tools: Record<string, Tool>, onActivity?: () => void): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    // Only wrap tools that have an execute function
    if (!tool.execute) {
      wrapped[name] = tool;
      continue;
    }

    const originalExecute = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (args: Parameters<typeof originalExecute>[0], options) => {
        // Mark the MCP server set as active *before* execution, so failed tool
        // calls (including closed-client races) still count as activity.
        onActivity?.();

        const result: unknown = await originalExecute(args, options);
        return transformMCPResult(result as MCPCallToolResult);
      },
    };
  }
  return wrapped;
}

type ResolvedHeaders = Record<string, string> | undefined;

type ResolvedTransport = "stdio" | "http" | "sse";

function resolveHeaders(
  headers: Record<string, MCPHeaderValue> | undefined,
  projectSecrets: Record<string, string> | undefined
): { headers: ResolvedHeaders; usesSecretHeaders: boolean } {
  if (!headers) {
    return { headers: undefined, usesSecretHeaders: false };
  }

  const resolved: Record<string, string> = {};
  let usesSecretHeaders = false;

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      resolved[key] = value;
      continue;
    }

    usesSecretHeaders = true;
    const secretKey = value.secret;
    const secretValue = projectSecrets?.[secretKey];
    if (typeof secretValue !== "string") {
      throw new Error(`Missing project secret: ${secretKey}`);
    }
    resolved[key] = secretValue;
  }

  return { headers: resolved, usesSecretHeaders };
}

function extractHttpStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const obj = error as Record<string, unknown>;

  // A few common shapes across fetch libraries / AI SDK.
  const statusCode = obj.statusCode;
  if (typeof statusCode === "number") {
    return statusCode;
  }

  const status = obj.status;
  if (typeof status === "number") {
    return status;
  }

  const response = obj.response;
  if (response && typeof response === "object") {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === "number") {
      return responseStatus;
    }
  }

  const cause = obj.cause;
  if (cause && typeof cause === "object") {
    const causeStatus = (cause as Record<string, unknown>).statusCode;
    if (typeof causeStatus === "number") {
      return causeStatus;
    }
  }

  // Best-effort fallback on message contents.
  const message = obj.message;
  if (typeof message === "string") {
    const re = /\b(400|404|405)\b/;
    const match = re.exec(message);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

function shouldAutoFallbackToSse(error: unknown): boolean {
  const status = extractHttpStatusCode(error);
  return status === 400 || status === 404 || status === 405;
}

export type { MCPTestResult } from "@/common/types/mcp";

/**
 * Run a test connection to an MCP server.
 * Connects, fetches tools, then closes.
 */
async function runServerTest(
  server:
    | { transport: "stdio"; command: string }
    | { transport: "http" | "sse" | "auto"; url: string; headers?: ResolvedHeaders },
  projectPath: string,
  logContext: string
): Promise<MCPTestResult> {
  const timeoutPromise = new Promise<MCPTestResult>((resolve) =>
    setTimeout(() => resolve({ success: false, error: "Connection timed out" }), TEST_TIMEOUT_MS)
  );

  const testPromise = (async (): Promise<MCPTestResult> => {
    let stdioTransport: MCPStdioTransport | null = null;
    let client: Awaited<ReturnType<typeof experimental_createMCPClient>> | null = null;

    try {
      if (server.transport === "stdio") {
        const runtime = createRuntime({ type: "local", srcBaseDir: projectPath });
        log.debug(`[MCP] Testing ${logContext}`, { transport: "stdio" });

        const execStream = await runtime.exec(server.command, {
          cwd: projectPath,
          timeout: TEST_TIMEOUT_MS / 1000,
        });

        stdioTransport = new MCPStdioTransport(execStream);
        await stdioTransport.start();
        client = await experimental_createMCPClient({ transport: stdioTransport });
      } else {
        log.debug(`[MCP] Testing ${logContext}`, { transport: server.transport });

        const tryHttp = async () =>
          experimental_createMCPClient({
            transport: {
              type: "http",
              url: server.url,
              headers: server.headers,
            },
          });

        const trySse = async () =>
          experimental_createMCPClient({
            transport: {
              type: "sse",
              url: server.url,
              headers: server.headers,
            },
          });

        if (server.transport === "http") {
          client = await tryHttp();
        } else if (server.transport === "sse") {
          client = await trySse();
        } else {
          // auto
          try {
            client = await tryHttp();
          } catch (error) {
            if (!shouldAutoFallbackToSse(error)) {
              throw error;
            }
            log.debug(`[MCP] ${logContext} auto-fallback http→sse`, {
              status: extractHttpStatusCode(error),
            });
            client = await trySse();
          }
        }
      }

      const tools = await client.tools();
      const toolNames = Object.keys(tools);

      await client.close();
      client = null;

      if (stdioTransport) {
        await stdioTransport.close();
        stdioTransport = null;
      }

      log.info(`[MCP] ${logContext} test successful`, { toolCount: toolNames.length });
      return { success: true, tools: toolNames };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[MCP] ${logContext} test failed`, { error: message });

      if (client) {
        try {
          await client.close();
        } catch {
          // ignore cleanup errors
        }
      }

      if (stdioTransport) {
        try {
          await stdioTransport.close();
        } catch {
          // ignore cleanup errors
        }
      }

      return { success: false, error: message };
    }
  })();

  return Promise.race([testPromise, timeoutPromise]);
}

interface MCPServerInstance {
  name: string;
  /** Resolved transport actually used (auto may fall back to sse). */
  resolvedTransport: ResolvedTransport;
  autoFallbackUsed: boolean;
  tools: Record<string, Tool>;
  /** True once the underlying MCP client/transport has been closed. */
  isClosed: boolean;
  close: () => Promise<void>;
}

export type MCPTransportMode = "none" | "stdio_only" | "http_only" | "sse_only" | "mixed";

export interface MCPWorkspaceStats {
  enabledServerCount: number;
  startedServerCount: number;
  failedServerCount: number;
  autoFallbackCount: number;

  hasStdio: boolean;
  hasHttp: boolean;
  hasSse: boolean;
  transportMode: MCPTransportMode;
}

export interface MCPToolsForWorkspaceResult {
  tools: Record<string, Tool>;
  stats: MCPWorkspaceStats;
}
interface WorkspaceServers {
  configSignature: string;
  instances: Map<string, MCPServerInstance>;
  stats: MCPWorkspaceStats;
  lastActivity: number;
}

export interface MCPServerManagerOptions {
  /** Inline stdio servers to use (merged with config file servers by default) */
  inlineServers?: Record<string, string>;
  /** If true, ignore config file servers and use only inline servers */
  ignoreConfigFile?: boolean;
}

export class MCPServerManager {
  private readonly workspaceServers = new Map<string, WorkspaceServers>();
  private readonly workspaceLeases = new Map<string, number>();
  private readonly idleCheckInterval: ReturnType<typeof setInterval>;
  private inlineServers: Record<string, string> = {};
  private ignoreConfigFile = false;

  constructor(
    private readonly configService: MCPConfigService,
    options?: MCPServerManagerOptions
  ) {
    this.idleCheckInterval = setInterval(() => this.cleanupIdleServers(), IDLE_CHECK_INTERVAL_MS);
    this.idleCheckInterval.unref?.();
    if (options?.inlineServers) {
      this.inlineServers = options.inlineServers;
    }
    if (options?.ignoreConfigFile) {
      this.ignoreConfigFile = options.ignoreConfigFile;
    }
  }

  /**
   * Stop the idle cleanup interval. Call when shutting down.
   */
  dispose(): void {
    clearInterval(this.idleCheckInterval);
  }

  private getLeaseCount(workspaceId: string): number {
    return this.workspaceLeases.get(workspaceId) ?? 0;
  }

  /**
   * Mark a workspace's MCP servers as actively in-use.
   *
   * This prevents idle cleanup from shutting down MCP clients while a stream is
   * still running (which can otherwise surface as "Attempted to send a request
   * from a closed client").
   */
  acquireLease(workspaceId: string): void {
    const current = this.workspaceLeases.get(workspaceId) ?? 0;
    this.workspaceLeases.set(workspaceId, current + 1);
    this.markActivity(workspaceId);
  }

  /**
   * Release a previously-acquired lease.
   */
  releaseLease(workspaceId: string): void {
    const current = this.workspaceLeases.get(workspaceId) ?? 0;
    if (current <= 0) {
      log.debug("[MCP] releaseLease called without an active lease", { workspaceId });
      return;
    }

    if (current === 1) {
      this.workspaceLeases.delete(workspaceId);
      return;
    }

    this.workspaceLeases.set(workspaceId, current - 1);
  }

  private markActivity(workspaceId: string): void {
    const entry = this.workspaceServers.get(workspaceId);
    if (!entry) {
      return;
    }
    entry.lastActivity = Date.now();
  }

  private cleanupIdleServers(): void {
    const now = Date.now();
    for (const [workspaceId, entry] of this.workspaceServers) {
      if (entry.instances.size === 0) continue;

      // Never tear down a workspace's MCP servers while a stream is running.
      if (this.getLeaseCount(workspaceId) > 0) {
        continue;
      }

      const idleMs = now - entry.lastActivity;
      if (idleMs >= IDLE_TIMEOUT_MS) {
        log.info("[MCP] Stopping idle servers", {
          workspaceId,
          idleMinutes: Math.round(idleMs / 60_000),
        });
        void this.stopServers(workspaceId);
      }
    }
  }

  /**
   * Get all servers from config (both enabled and disabled) + inline servers.
   * Returns full MCPServerInfo to preserve disabled state.
   */
  private async getAllServers(projectPath: string): Promise<Record<string, MCPServerInfo>> {
    const configServers = this.ignoreConfigFile
      ? {}
      : await this.configService.listServers(projectPath);
    // Inline servers override config file servers (always enabled)
    const inlineAsInfo: Record<string, MCPServerInfo> = {};
    for (const [name, command] of Object.entries(this.inlineServers)) {
      inlineAsInfo[name] = { transport: "stdio", command, disabled: false };
    }
    return { ...configServers, ...inlineAsInfo };
  }

  /**
   * List configured MCP servers for a project (name -> command).
   * Used to show server info in the system prompt.
   *
   * Applies both project-level disabled state and workspace-level overrides:
   * - Project disabled + workspace enabled => enabled
   * - Project enabled + workspace disabled => disabled
   * - No workspace override => use project state
   *
   * @param projectPath - Project path to get servers for
   * @param overrides - Optional workspace-level overrides
   */
  async listServers(projectPath: string, overrides?: WorkspaceMCPOverrides): Promise<MCPServerMap> {
    const allServers = await this.getAllServers(projectPath);
    return this.applyServerOverrides(allServers, overrides);
  }

  /**
   * Apply workspace MCP overrides to determine final server enabled state.
   *
   * Logic:
   * - If server is in enabledServers: enabled (overrides project disabled)
   * - If server is in disabledServers: disabled (overrides project enabled)
   * - Otherwise: use project-level disabled state
   */
  private applyServerOverrides(
    servers: Record<string, MCPServerInfo>,
    overrides?: WorkspaceMCPOverrides
  ): MCPServerMap {
    const enabledSet = new Set(overrides?.enabledServers ?? []);
    const disabledSet = new Set(overrides?.disabledServers ?? []);

    const result: MCPServerMap = {};
    for (const [name, info] of Object.entries(servers)) {
      // Workspace overrides take precedence
      if (enabledSet.has(name)) {
        // Explicitly enabled at workspace level (overrides project disabled)
        result[name] = { ...info, disabled: false };
        continue;
      }

      if (disabledSet.has(name)) {
        // Explicitly disabled at workspace level - skip
        continue;
      }

      if (!info.disabled) {
        // Enabled at project level, no workspace override
        result[name] = info;
      }
      // If disabled at project level with no workspace override, skip
    }

    return result;
  }

  /**
   * Apply tool allowlists to filter tools from a server.
   * Project-level allowlist is applied first, then workspace-level (intersection).
   *
   * @param serverName - Name of the MCP server (used for allowlist lookup)
   * @param tools - Record of tool name -> Tool (NOT namespaced)
   * @param projectAllowlist - Optional project-level tool allowlist (from .mux/mcp.jsonc)
   * @param workspaceOverrides - Optional workspace MCP overrides containing toolAllowlist
   * @returns Filtered tools record
   */
  private applyToolAllowlist(
    serverName: string,
    tools: Record<string, Tool>,
    projectAllowlist?: string[],
    workspaceOverrides?: WorkspaceMCPOverrides
  ): Record<string, Tool> {
    const workspaceAllowlist = workspaceOverrides?.toolAllowlist?.[serverName];

    // Determine effective allowlist:
    // - If both exist: intersection (workspace restricts further)
    // - If only project: use project
    // - If only workspace: use workspace
    // - If neither: no filtering
    let effectiveAllowlist: Set<string> | null = null;

    if (projectAllowlist && projectAllowlist.length > 0 && workspaceAllowlist) {
      // Intersection of both allowlists
      const projectSet = new Set(projectAllowlist);
      effectiveAllowlist = new Set(workspaceAllowlist.filter((t) => projectSet.has(t)));
    } else if (projectAllowlist && projectAllowlist.length > 0) {
      effectiveAllowlist = new Set(projectAllowlist);
    } else if (workspaceAllowlist) {
      effectiveAllowlist = new Set(workspaceAllowlist);
    }

    if (!effectiveAllowlist) {
      // No allowlist => return all tools
      return tools;
    }

    // Filter to only allowed tools
    const filtered: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (effectiveAllowlist.has(name)) {
        filtered[name] = tool;
      }
    }

    log.debug("[MCP] Applied tool allowlist", {
      serverName,
      projectAllowlist,
      workspaceAllowlist,
      effectiveCount: effectiveAllowlist.size,
      originalCount: Object.keys(tools).length,
      filteredCount: Object.keys(filtered).length,
    });

    return filtered;
  }

  async getToolsForWorkspace(options: {
    workspaceId: string;
    projectPath: string;
    runtime: Runtime;
    workspacePath: string;
    /** Per-workspace MCP overrides (disabled servers, tool allowlists) */
    overrides?: WorkspaceMCPOverrides;
    /** Project secrets, used for resolving {secret: "KEY"} header references. */
    projectSecrets?: Record<string, string>;
  }): Promise<MCPToolsForWorkspaceResult> {
    const { workspaceId, projectPath, runtime, workspacePath, overrides, projectSecrets } = options;

    // Fetch full server info for project-level allowlists and server filtering
    const fullServerInfo = await this.getAllServers(projectPath);

    // Apply server-level overrides (enabled/disabled) before caching
    const enabledServers = this.applyServerOverrides(fullServerInfo, overrides);
    const enabledEntries = Object.entries(enabledServers).sort(([a], [b]) => a.localeCompare(b));

    // Signature is based on *start config* only (not tool allowlists), so changing allowlists
    // does not force a server restart.
    const signatureEntries: Record<string, unknown> = {};
    for (const [name, info] of enabledEntries) {
      if (info.transport === "stdio") {
        signatureEntries[name] = { transport: "stdio", command: info.command };
        continue;
      }

      try {
        const { headers } = resolveHeaders(info.headers, projectSecrets);
        signatureEntries[name] = { transport: info.transport, url: info.url, headers };
      } catch {
        // Missing secrets or invalid header config. Keep signature stable but avoid leaking details.
        signatureEntries[name] = { transport: info.transport, url: info.url, headers: null };
      }
    }

    const signature = JSON.stringify(signatureEntries);

    const existing = this.workspaceServers.get(workspaceId);
    const leaseCount = this.getLeaseCount(workspaceId);

    const hasClosedInstance =
      existing && [...existing.instances.values()].some((instance) => instance.isClosed);

    if (existing?.configSignature === signature && !hasClosedInstance) {
      existing.lastActivity = Date.now();
      log.debug("[MCP] Using cached servers", {
        workspaceId,
        serverCount: enabledEntries.length,
      });

      return {
        tools: this.collectTools(existing.instances, fullServerInfo, overrides),
        stats: existing.stats,
      };
    }

    // If a stream is actively running, avoid closing MCP clients out from under it.
    //
    // Note: AIService may fetch tools before StreamManager interrupts an existing stream,
    // so closing servers here can hand out tool objects backed by a client that's about to close.
    if (existing && leaseCount > 0) {
      existing.lastActivity = Date.now();

      if (hasClosedInstance) {
        // One or more server instances died while another stream was still active.
        //
        // Critical: do NOT stop all servers here, or we'd close healthy clients that the
        // in-flight stream may still be using.
        const closedServerNames = [...existing.instances.values()]
          .filter((instance) => instance.isClosed)
          .map((instance) => instance.name);

        log.info("[MCP] Restarting closed server instances while stream is active", {
          workspaceId,
          closedServerNames,
        });

        const serversToRestart: MCPServerMap = {};
        for (const serverName of closedServerNames) {
          const info = enabledServers[serverName];
          if (info) {
            serversToRestart[serverName] = info;
          }
        }

        // Remove closed instances first so we don't hand out tools backed by a dead client.
        for (const serverName of closedServerNames) {
          const instance = existing.instances.get(serverName);
          if (!instance) {
            continue;
          }

          existing.instances.delete(serverName);

          try {
            await instance.close();
          } catch (error) {
            log.debug("[MCP] Error closing dead instance", { workspaceId, serverName, error });
          }
        }

        const restartedInstances = await this.startServers(
          serversToRestart,
          runtime,
          workspacePath,
          projectSecrets,
          () => this.markActivity(workspaceId)
        );

        for (const [serverName, instance] of restartedInstances) {
          existing.instances.set(serverName, instance);
        }
      }

      log.info("[MCP] Deferring MCP server restart while stream is active", {
        workspaceId,
      });

      // Even while deferring restarts, ensure new tool lists reflect the latest enabled/disabled
      // server set. We cannot revoke tools already captured by an in-flight stream, but we
      // can avoid exposing tools from newly-disabled servers to the next stream.
      const instancesForTools = new Map(
        [...existing.instances].filter(([serverName]) => enabledServers[serverName] !== undefined)
      );

      return {
        tools: this.collectTools(instancesForTools, fullServerInfo, overrides),
        stats: existing.stats,
      };
    }

    // Config changed, instance closed, or not started yet -> restart
    if (enabledEntries.length > 0) {
      log.info("[MCP] Starting servers", {
        workspaceId,
        servers: enabledEntries.map(([name]) => name),
      });
    }

    if (existing && hasClosedInstance) {
      log.info("[MCP] Restarting servers due to closed client", { workspaceId });
    }

    await this.stopServers(workspaceId);

    const instances = await this.startServers(
      enabledServers,
      runtime,
      workspacePath,
      projectSecrets,
      () => this.markActivity(workspaceId)
    );

    const resolvedTransports = new Set<ResolvedTransport>();
    for (const instance of instances.values()) {
      resolvedTransports.add(instance.resolvedTransport);
    }

    const hasStdio = resolvedTransports.has("stdio");
    const hasHttp = resolvedTransports.has("http");
    const hasSse = resolvedTransports.has("sse");

    const transportMode: MCPTransportMode =
      instances.size === 0
        ? "none"
        : resolvedTransports.size === 1 && hasStdio
          ? "stdio_only"
          : resolvedTransports.size === 1 && hasHttp
            ? "http_only"
            : resolvedTransports.size === 1 && hasSse
              ? "sse_only"
              : "mixed";

    const stats: MCPWorkspaceStats = {
      enabledServerCount: enabledEntries.length,
      startedServerCount: instances.size,
      failedServerCount: Math.max(0, enabledEntries.length - instances.size),
      autoFallbackCount: [...instances.values()].filter((i) => i.autoFallbackUsed).length,
      hasStdio,
      hasHttp,
      hasSse,
      transportMode,
    };

    this.workspaceServers.set(workspaceId, {
      configSignature: signature,
      instances,
      stats,
      lastActivity: Date.now(),
    });

    return {
      tools: this.collectTools(instances, fullServerInfo, overrides),
      stats,
    };
  }

  async stopServers(workspaceId: string): Promise<void> {
    const entry = this.workspaceServers.get(workspaceId);
    if (!entry) return;

    // Remove from cache immediately so callers can't re-use tools backed by a
    // client that is in the middle of closing.
    this.workspaceServers.delete(workspaceId);

    for (const instance of entry.instances.values()) {
      try {
        await instance.close();
      } catch (error) {
        log.warn("Failed to stop MCP server", { error, name: instance.name });
      }
    }
  }

  /**
   * Test an MCP server.
   *
   * Provide either:
   * - `name` to test a configured server by looking up its config, OR
   * - `command` to test an arbitrary stdio command, OR
   * - `url`+`transport` to test an arbitrary HTTP/SSE endpoint.
   */
  async test(options: {
    projectPath: string;
    name?: string;
    command?: string;
    transport?: MCPServerTransport;
    url?: string;
    headers?: Record<string, MCPHeaderValue>;
    projectSecrets?: Record<string, string>;
  }): Promise<MCPTestResult> {
    const { projectPath, name, command, transport, url, headers, projectSecrets } = options;

    if (name?.trim()) {
      const servers = await this.configService.listServers(projectPath);
      const server = servers[name];
      if (!server) {
        return { success: false, error: `Server "${name}" not found in configuration` };
      }

      if (server.transport === "stdio") {
        return runServerTest(
          { transport: "stdio", command: server.command },
          projectPath,
          `server "${name}"`
        );
      }

      try {
        const resolved = resolveHeaders(server.headers, projectSecrets);
        return runServerTest(
          { transport: server.transport, url: server.url, headers: resolved.headers },
          projectPath,
          `server "${name}"`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }

    if (command?.trim()) {
      return runServerTest({ transport: "stdio", command }, projectPath, "command");
    }

    if (url?.trim()) {
      if (transport !== "http" && transport !== "sse" && transport !== "auto") {
        return { success: false, error: "transport must be http|sse|auto when testing by url" };
      }

      try {
        const resolved = resolveHeaders(headers, projectSecrets);
        return runServerTest({ transport, url, headers: resolved.headers }, projectPath, "url");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }

    return { success: false, error: "Either name, command, or url is required" };
  }

  /**
   * Collect tools from all server instances, applying tool allowlists.
   *
   * @param instances - Map of server instances
   * @param serverInfo - Project-level server info (for project-level tool allowlists)
   * @param workspaceOverrides - Optional workspace MCP overrides for tool allowlists
   * @returns Aggregated tools record with namespaced names (serverName_toolName)
   */
  private collectTools(
    instances: Map<string, MCPServerInstance>,
    serverInfo: Record<string, MCPServerInfo>,
    workspaceOverrides?: WorkspaceMCPOverrides
  ): Record<string, Tool> {
    const aggregated: Record<string, Tool> = {};
    for (const instance of instances.values()) {
      // Get project-level allowlist for this server
      const projectAllowlist = serverInfo[instance.name]?.toolAllowlist;
      // Apply tool allowlist filtering (project-level + workspace-level)
      const filteredTools = this.applyToolAllowlist(
        instance.name,
        instance.tools,
        projectAllowlist,
        workspaceOverrides
      );
      for (const [toolName, tool] of Object.entries(filteredTools)) {
        // Namespace tools with server name to prevent collisions
        const namespacedName = `${instance.name}_${toolName}`;
        aggregated[namespacedName] = tool;
      }
    }
    return aggregated;
  }

  private async startServers(
    servers: MCPServerMap,
    runtime: Runtime,
    workspacePath: string,
    projectSecrets: Record<string, string> | undefined,
    onActivity: () => void
  ): Promise<Map<string, MCPServerInstance>> {
    const result = new Map<string, MCPServerInstance>();
    const entries = Object.entries(servers);

    for (const [name, info] of entries) {
      try {
        const instance = await this.startSingleServer(
          name,
          info,
          runtime,
          workspacePath,
          projectSecrets,
          onActivity
        );
        if (instance) {
          result.set(name, instance);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Failed to start MCP server", { name, error: message });
      }
    }

    return result;
  }

  private async startSingleServer(
    name: string,
    info: MCPServerInfo,
    runtime: Runtime,
    workspacePath: string,
    projectSecrets: Record<string, string> | undefined,
    onActivity: () => void
  ): Promise<MCPServerInstance | null> {
    if (info.transport === "stdio") {
      log.debug("[MCP] Spawning stdio server", { name });
      const execStream = await runtime.exec(info.command, {
        cwd: workspacePath,
        timeout: 60 * 60 * 24, // 24 hours
      });

      const transport = new MCPStdioTransport(execStream);

      const instanceRef: { current: MCPServerInstance | null } = { current: null };
      let transportClosed = false;
      const markClosed = () => {
        if (transportClosed) {
          return;
        }
        transportClosed = true;
        if (instanceRef.current) {
          instanceRef.current.isClosed = true;
        }
      };

      transport.onclose = markClosed;

      transport.onerror = (error) => {
        log.error("[MCP] Transport error", { name, error });
      };

      await transport.start();
      const client = await experimental_createMCPClient({ transport });
      const rawTools = await client.tools();
      const tools = wrapMCPTools(rawTools as unknown as Record<string, Tool>, onActivity);

      log.info("[MCP] Server ready", {
        name,
        transport: "stdio",
        toolCount: Object.keys(tools).length,
      });

      const instance: MCPServerInstance = {
        name,
        resolvedTransport: "stdio",
        autoFallbackUsed: false,
        tools,
        isClosed: transportClosed,
        close: async () => {
          // Mark closed first to prevent any new tool calls from being treated as
          // valid by higher-level caching logic.
          markClosed();

          try {
            await client.close();
          } catch (error) {
            log.debug("[MCP] Error closing client", { name, error });
          }
          try {
            await transport.close();
          } catch (error) {
            log.debug("[MCP] Error closing transport", { name, error });
          }
        },
      };

      instanceRef.current = instance;
      return instance;
    }

    const { headers } = resolveHeaders(info.headers, projectSecrets);

    const tryHttp = async () =>
      experimental_createMCPClient({
        transport: {
          type: "http",
          url: info.url,
          headers,
        },
      });

    const trySse = async () =>
      experimental_createMCPClient({
        transport: {
          type: "sse",
          url: info.url,
          headers,
        },
      });

    let client: Awaited<ReturnType<typeof experimental_createMCPClient>>;
    let resolvedTransport: ResolvedTransport;
    let autoFallbackUsed = false;

    if (info.transport === "http") {
      resolvedTransport = "http";
      client = await tryHttp();
    } else if (info.transport === "sse") {
      resolvedTransport = "sse";
      client = await trySse();
    } else {
      // auto
      try {
        resolvedTransport = "http";
        client = await tryHttp();
      } catch (error) {
        if (!shouldAutoFallbackToSse(error)) {
          throw error;
        }
        autoFallbackUsed = true;
        resolvedTransport = "sse";
        log.debug("[MCP] Auto-fallback http→sse", { name, status: extractHttpStatusCode(error) });
        client = await trySse();
      }
    }

    let clientClosed = false;

    const rawTools = await client.tools();
    const tools = wrapMCPTools(rawTools as unknown as Record<string, Tool>, onActivity);

    log.info("[MCP] Server ready", {
      name,
      transport: resolvedTransport,
      toolCount: Object.keys(tools).length,
      autoFallbackUsed,
    });

    const instance: MCPServerInstance = {
      name,
      resolvedTransport,
      autoFallbackUsed,
      tools,
      isClosed: clientClosed,
      close: async () => {
        // Mark closed first to prevent any new tool calls from being treated as
        // valid by higher-level caching logic.
        if (!clientClosed) {
          clientClosed = true;
          instance.isClosed = true;
        }

        try {
          await client.close();
        } catch (error) {
          log.debug("[MCP] Error closing client", { name, error });
        }
      },
    };

    return instance;
  }
}
