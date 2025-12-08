import * as fs from "fs";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import type { MCPConfig, MCPServerMap } from "@/common/types/mcp";
import { log } from "@/node/services/log";
import { Ok, Err } from "@/common/types/result";
import type { Result } from "@/common/types/result";

export class MCPConfigService {
  private getConfigPath(projectPath: string): string {
    return path.join(projectPath, ".mux", "mcp.jsonc");
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureProjectDir(projectPath: string): Promise<void> {
    const muxDir = path.join(projectPath, ".mux");
    if (!(await this.pathExists(muxDir))) {
      await fs.promises.mkdir(muxDir, { recursive: true });
    }
  }

  async getConfig(projectPath: string): Promise<MCPConfig> {
    const filePath = this.getConfigPath(projectPath);
    try {
      const exists = await this.pathExists(filePath);
      if (!exists) {
        return { servers: {} };
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = jsonc.parse(raw) as MCPConfig | undefined;
      if (!parsed || typeof parsed !== "object" || !parsed.servers) {
        return { servers: {} };
      }
      return { servers: parsed.servers };
    } catch (error) {
      log.error("Failed to read MCP config", { projectPath, error });
      return { servers: {} };
    }
  }

  private async saveConfig(projectPath: string, config: MCPConfig): Promise<void> {
    await this.ensureProjectDir(projectPath);
    const filePath = this.getConfigPath(projectPath);
    await writeFileAtomic(filePath, JSON.stringify(config, null, 2), "utf-8");
  }

  async listServers(projectPath: string): Promise<MCPServerMap> {
    const cfg = await this.getConfig(projectPath);
    return cfg.servers;
  }

  async addServer(projectPath: string, name: string, command: string): Promise<Result<void>> {
    if (!name.trim()) {
      return Err("Server name is required");
    }
    if (!command.trim()) {
      return Err("Command is required");
    }

    const cfg = await this.getConfig(projectPath);
    cfg.servers[name] = command;

    try {
      await this.saveConfig(projectPath, cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to save MCP server", { projectPath, name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }

  async removeServer(projectPath: string, name: string): Promise<Result<void>> {
    const cfg = await this.getConfig(projectPath);
    if (!cfg.servers?.[name]) {
      return Err(`Server ${name} not found`);
    }
    delete cfg.servers[name];
    try {
      await this.saveConfig(projectPath, cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to remove MCP server", { projectPath, name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }
}
