import * as fs from "fs";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import type { MCPConfig, MCPServerInfo } from "@/common/types/mcp";
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

  /** Raw config file format - string (legacy) or object */
  private normalizeEntry(entry: string | { command: string; disabled?: boolean }): MCPServerInfo {
    if (typeof entry === "string") {
      return { command: entry, disabled: false };
    }
    return { command: entry.command, disabled: entry.disabled ?? false };
  }

  async getConfig(projectPath: string): Promise<MCPConfig> {
    const filePath = this.getConfigPath(projectPath);
    try {
      const exists = await this.pathExists(filePath);
      if (!exists) {
        return { servers: {} };
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = jsonc.parse(raw) as { servers?: Record<string, unknown> } | undefined;
      if (!parsed || typeof parsed !== "object" || !parsed.servers) {
        return { servers: {} };
      }
      // Normalize all entries on read
      const servers: Record<string, MCPServerInfo> = {};
      for (const [name, entry] of Object.entries(parsed.servers)) {
        servers[name] = this.normalizeEntry(
          entry as string | { command: string; disabled?: boolean }
        );
      }
      return { servers };
    } catch (error) {
      log.error("Failed to read MCP config", { projectPath, error });
      return { servers: {} };
    }
  }

  private async saveConfig(projectPath: string, config: MCPConfig): Promise<void> {
    await this.ensureProjectDir(projectPath);
    const filePath = this.getConfigPath(projectPath);
    // Write minimal format: string for enabled, object only when disabled
    const output: Record<string, string | { command: string; disabled: true }> = {};
    for (const [name, entry] of Object.entries(config.servers)) {
      output[name] = entry.disabled ? { command: entry.command, disabled: true } : entry.command;
    }
    await writeFileAtomic(filePath, JSON.stringify({ servers: output }, null, 2), "utf-8");
  }

  /** List all servers with normalized config */
  async listServers(projectPath: string): Promise<Record<string, MCPServerInfo>> {
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
    const existing = cfg.servers[name];
    // Preserve disabled state if updating existing server
    cfg.servers[name] = { command, disabled: existing?.disabled ?? false };

    try {
      await this.saveConfig(projectPath, cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to save MCP server", { projectPath, name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }

  async setServerEnabled(
    projectPath: string,
    name: string,
    enabled: boolean
  ): Promise<Result<void>> {
    const cfg = await this.getConfig(projectPath);
    const entry = cfg.servers[name];
    if (!entry) {
      return Err(`Server ${name} not found`);
    }
    cfg.servers[name] = { ...entry, disabled: !enabled };
    try {
      await this.saveConfig(projectPath, cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to update MCP server enabled state", { projectPath, name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }

  async removeServer(projectPath: string, name: string): Promise<Result<void>> {
    const cfg = await this.getConfig(projectPath);
    if (!cfg.servers[name]) {
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
