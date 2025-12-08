import { experimental_createMCPClient, type MCPTransport } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { log } from "@/node/services/log";
import { MCPStdioTransport } from "@/node/services/mcpStdioTransport";
import type { MCPServerMap, MCPTestResult } from "@/common/types/mcp";
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
function wrapMCPTools(tools: Record<string, Tool>): Record<string, Tool> {
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
        const result: unknown = await originalExecute(args, options);
        return transformMCPResult(result as MCPCallToolResult);
      },
    };
  }
  return wrapped;
}

export type { MCPTestResult } from "@/common/types/mcp";

/**
 * Run a test connection to an MCP server command.
 * Spawns the process, connects, fetches tools, then closes.
 */
async function runServerTest(
  command: string,
  projectPath: string,
  logContext: string
): Promise<MCPTestResult> {
  const runtime = createRuntime({ type: "local", srcBaseDir: projectPath });
  const timeoutPromise = new Promise<MCPTestResult>((resolve) =>
    setTimeout(() => resolve({ success: false, error: "Connection timed out" }), TEST_TIMEOUT_MS)
  );

  const testPromise = (async (): Promise<MCPTestResult> => {
    let transport: MCPStdioTransport | null = null;
    try {
      log.debug(`[MCP] Testing ${logContext}`, { command });
      const execStream = await runtime.exec(command, {
        cwd: projectPath,
        timeout: TEST_TIMEOUT_MS / 1000,
      });

      transport = new MCPStdioTransport(execStream);
      await transport.start();
      const client = await experimental_createMCPClient({ transport });
      const tools = await client.tools();
      const toolNames = Object.keys(tools);
      await client.close();
      await transport.close();
      log.info(`[MCP] ${logContext} test successful`, { tools: toolNames });
      return { success: true, tools: toolNames };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[MCP] ${logContext} test failed`, { error: message });
      if (transport) {
        try {
          await transport.close();
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
  transport: MCPTransport;
  tools: Record<string, Tool>;
  close: () => Promise<void>;
}

interface WorkspaceServers {
  configSignature: string;
  instances: Map<string, MCPServerInstance>;
  lastActivity: number;
}

export class MCPServerManager {
  private readonly workspaceServers = new Map<string, WorkspaceServers>();
  private readonly idleCheckInterval: ReturnType<typeof setInterval>;

  constructor(private readonly configService: MCPConfigService) {
    this.idleCheckInterval = setInterval(() => this.cleanupIdleServers(), IDLE_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the idle cleanup interval. Call when shutting down.
   */
  dispose(): void {
    clearInterval(this.idleCheckInterval);
  }

  private cleanupIdleServers(): void {
    const now = Date.now();
    for (const [workspaceId, entry] of this.workspaceServers) {
      if (entry.instances.size === 0) continue;
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
   * List configured MCP servers for a project (name -> command).
   * Used to show server info in the system prompt.
   */
  async listServers(projectPath: string): Promise<MCPServerMap> {
    return this.configService.listServers(projectPath);
  }

  async getToolsForWorkspace(options: {
    workspaceId: string;
    projectPath: string;
    runtime: Runtime;
    workspacePath: string;
  }): Promise<Record<string, Tool>> {
    const { workspaceId, projectPath, runtime, workspacePath } = options;
    const servers = await this.configService.listServers(projectPath);
    const signature = JSON.stringify(servers);
    const serverNames = Object.keys(servers);

    const existing = this.workspaceServers.get(workspaceId);
    if (existing?.configSignature === signature) {
      // Update activity timestamp to prevent idle cleanup
      existing.lastActivity = Date.now();
      log.debug("[MCP] Using cached servers", { workspaceId, serverCount: serverNames.length });
      return this.collectTools(existing.instances);
    }

    // Config changed or not started yet -> restart
    if (serverNames.length > 0) {
      log.info("[MCP] Starting servers", { workspaceId, servers: serverNames });
    }
    await this.stopServers(workspaceId);
    const instances = await this.startServers(servers, runtime, workspacePath);
    this.workspaceServers.set(workspaceId, {
      configSignature: signature,
      instances,
      lastActivity: Date.now(),
    });
    return this.collectTools(instances);
  }

  async stopServers(workspaceId: string): Promise<void> {
    const entry = this.workspaceServers.get(workspaceId);
    if (!entry) return;

    for (const instance of entry.instances.values()) {
      try {
        await instance.close();
      } catch (error) {
        log.warn("Failed to stop MCP server", { error, name: instance.name });
      }
    }

    this.workspaceServers.delete(workspaceId);
  }

  /**
   * Test an MCP server. Provide either:
   * - `name` to test a configured server by looking up its command
   * - `command` to test an arbitrary command directly
   */
  async test(projectPath: string, name?: string, command?: string): Promise<MCPTestResult> {
    if (name) {
      const servers = await this.configService.listServers(projectPath);
      const serverCommand = servers[name];
      if (!serverCommand) {
        return { success: false, error: `Server "${name}" not found in configuration` };
      }
      return runServerTest(serverCommand, projectPath, `server "${name}"`);
    }
    if (command?.trim()) {
      return runServerTest(command, projectPath, "command");
    }
    return { success: false, error: "Either name or command is required" };
  }

  private collectTools(instances: Map<string, MCPServerInstance>): Record<string, Tool> {
    const aggregated: Record<string, Tool> = {};
    for (const instance of instances.values()) {
      for (const [toolName, tool] of Object.entries(instance.tools)) {
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
    workspacePath: string
  ): Promise<Map<string, MCPServerInstance>> {
    const result = new Map<string, MCPServerInstance>();
    const entries = Object.entries(servers);
    for (const [name, command] of entries) {
      try {
        const instance = await this.startSingleServer(name, command, runtime, workspacePath);
        if (instance) {
          result.set(name, instance);
        }
      } catch (error) {
        log.error("Failed to start MCP server", { name, error });
      }
    }
    return result;
  }

  private async startSingleServer(
    name: string,
    command: string,
    runtime: Runtime,
    workspacePath: string
  ): Promise<MCPServerInstance | null> {
    log.debug("[MCP] Spawning server", { name, command });
    const execStream = await runtime.exec(command, {
      cwd: workspacePath,
      timeout: 60 * 60 * 24, // 24 hours
    });

    const transport = new MCPStdioTransport(execStream);
    transport.onerror = (error) => {
      log.error("[MCP] Transport error", { name, error });
    };

    await transport.start();
    const client = await experimental_createMCPClient({ transport });
    const rawTools = await client.tools();
    const tools = wrapMCPTools(rawTools);
    const toolNames = Object.keys(tools);
    log.info("[MCP] Server ready", { name, tools: toolNames });

    const close = async () => {
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
    };

    return { name, transport, tools, close };
  }
}
