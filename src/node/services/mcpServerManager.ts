import { experimental_createMCPClient, type MCPTransport } from "@ai-sdk/mcp";
import type { Tool } from "ai";
import { log } from "@/node/services/log";
import { MCPStdioTransport } from "@/node/services/mcpStdioTransport";
import type { MCPServerMap } from "@/common/types/mcp";
import type { Runtime } from "@/node/runtime/Runtime";
import type { MCPConfigService } from "@/node/services/mcpConfigService";

interface MCPServerInstance {
  name: string;
  transport: MCPTransport;
  tools: Record<string, Tool>;
  close: () => Promise<void>;
}

interface WorkspaceServers {
  configSignature: string;
  instances: Map<string, MCPServerInstance>;
}

export class MCPServerManager {
  private readonly workspaceServers = new Map<string, WorkspaceServers>();

  constructor(private readonly configService: MCPConfigService) {}

  async getToolsForWorkspace(options: {
    workspaceId: string;
    projectPath: string;
    runtime: Runtime;
    workspacePath: string;
  }): Promise<Record<string, Tool>> {
    const { workspaceId, projectPath, runtime, workspacePath } = options;
    const servers = await this.configService.listServers(projectPath);
    const signature = JSON.stringify(servers ?? {});
    const serverCount = Object.keys(servers ?? {}).length;

    const existing = this.workspaceServers.get(workspaceId);
    if (existing?.configSignature === signature) {
      log.debug("[MCP] Using cached servers", { workspaceId, serverCount });
      return this.collectTools(existing.instances);
    }

    // Config changed or not started yet -> restart
    if (serverCount > 0) {
      log.info("[MCP] Starting servers", {
        workspaceId,
        servers: Object.keys(servers ?? {}),
      });
    }
    await this.stopServers(workspaceId);
    const instances = await this.startServers(servers, runtime, workspacePath);
    this.workspaceServers.set(workspaceId, {
      configSignature: signature,
      instances,
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

  private collectTools(instances: Map<string, MCPServerInstance>): Record<string, Tool> {
    const aggregated: Record<string, Tool> = {};
    for (const instance of instances.values()) {
      Object.assign(aggregated, instance.tools);
    }
    return aggregated;
  }

  private async startServers(
    servers: MCPServerMap,
    runtime: Runtime,
    workspacePath: string
  ): Promise<Map<string, MCPServerInstance>> {
    const result = new Map<string, MCPServerInstance>();
    const entries = Object.entries(servers ?? {});
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
    const tools = await client.tools();
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
