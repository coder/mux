import * as fs from "fs";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import type {
  MCPConfig,
  MCPConfigDiagnostics,
  MCPHeaderValue,
  MCPServerInfo,
  MCPServerTransport,
} from "@/common/types/mcp";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { Ok, Err } from "@/common/types/result";
import type { Result } from "@/common/types/result";

export class MCPConfigService {
  constructor(private readonly config: Config) {}

  // Avoid spamming logs when a config file is permanently malformed.
  private readonly loggedParseErrors = new Set<string>();

  private getProjectConfigPath(projectPath: string): string {
    return path.join(projectPath, ".mux", "mcp.jsonc");
  }

  private getGlobalConfigPath(): string {
    return path.join(this.config.rootDir, "mcp.jsonc");
  }

  // Backwards-compatible alias: existing call sites treat this as the project config file.
  private getConfigPath(projectPath: string): string {
    return this.getProjectConfigPath(projectPath);
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

  private logParseErrorsOnce(filePath: string, errors: jsonc.ParseError[]): void {
    if (errors.length === 0) {
      return;
    }

    if (this.loggedParseErrors.has(filePath)) {
      return;
    }

    this.loggedParseErrors.add(filePath);

    log.warn("[MCP] Failed to parse MCP config (JSONC parse errors)", {
      filePath,
      errorCount: errors.length,
    });
  }

  /**
   * Normalize a raw config entry into a strongly-typed server definition.
   *
   * Supported raw formats:
   * - string: stdio command
   * - object w/ command: stdio
   * - object w/ url: http/sse/auto (defaults to auto)
   */
  private normalizeEntry(entry: unknown): MCPServerInfo {
    if (typeof entry === "string") {
      return { transport: "stdio", command: entry, disabled: false };
    }

    if (!entry || typeof entry !== "object") {
      // Fail closed for invalid shapes.
      return { transport: "stdio", command: "", disabled: true };
    }

    const obj = entry as Record<string, unknown>;
    const disabled = typeof obj.disabled === "boolean" ? obj.disabled : false;
    const toolAllowlist = Array.isArray(obj.toolAllowlist)
      ? obj.toolAllowlist.filter((v): v is string => typeof v === "string")
      : undefined;

    const transport =
      obj.transport === "stdio" ||
      obj.transport === "http" ||
      obj.transport === "sse" ||
      obj.transport === "auto"
        ? obj.transport
        : undefined;

    const command = typeof obj.command === "string" ? obj.command : undefined;
    const url = typeof obj.url === "string" ? obj.url : undefined;

    const headersRaw = obj.headers;
    let headers: Record<string, string | { secret: string }> | undefined;

    if (headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)) {
      const next: Record<string, string | { secret: string }> = {};
      for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
        if (typeof v === "string") {
          next[k] = v;
          continue;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const secret = (v as Record<string, unknown>).secret;
          if (typeof secret === "string") {
            next[k] = { secret };
          }
        }
      }
      if (Object.keys(next).length > 0) {
        headers = next;
      }
    }

    // If it has a url field, prefer HTTP-based transports (default to auto).
    // Note: treat empty-string url as "configured but invalid" so diagnostics can surface it.
    if (url !== undefined) {
      const httpTransport = transport && transport !== "stdio" ? transport : "auto";
      return {
        transport: httpTransport,
        url,
        headers,
        disabled,
        toolAllowlist,
      };
    }

    // Otherwise, treat it as stdio.
    return {
      transport: "stdio",
      command: command ?? "",
      disabled,
      toolAllowlist,
    };
  }

  private validateServers(
    servers: Record<string, MCPServerInfo>
  ): MCPConfigDiagnostics["validationErrors"] {
    const validationErrors: MCPConfigDiagnostics["validationErrors"] = [];

    for (const [serverName, info] of Object.entries(servers)) {
      if (info.transport === "stdio") {
        if (!info.command.trim()) {
          validationErrors.push({ message: "missing command", serverName });
        }
        continue;
      }

      if (!info.url.trim()) {
        validationErrors.push({ message: "missing url", serverName });
      }
    }

    return validationErrors;
  }
  async getConfig(projectPath: string): Promise<MCPConfig> {
    const filePath = this.getConfigPath(projectPath);
    try {
      const exists = await this.pathExists(filePath);
      if (!exists) {
        return { servers: {} };
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const errors: jsonc.ParseError[] = [];
      const parsed = jsonc.parse(raw, errors) as { servers?: Record<string, unknown> } | undefined;

      if (errors.length > 0) {
        this.logParseErrorsOnce(filePath, errors);
        return { servers: {} };
      }

      if (!parsed || typeof parsed !== "object" || !parsed.servers) {
        return { servers: {} };
      }
      // Normalize all entries on read
      const servers: Record<string, MCPServerInfo> = {};
      for (const [name, entry] of Object.entries(parsed.servers)) {
        servers[name] = this.normalizeEntry(entry);
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

    // Write minimal format:
    // - string for stdio servers without extra settings
    // - object when:
    //   - disabled/toolAllowlist set, or
    //   - non-stdio transport, or
    //   - headers present
    //
    // toolAllowlist: undefined = all tools (omit), [] = no tools, [...] = those tools
    const output: Record<string, unknown> = {};

    for (const [name, entry] of Object.entries(config.servers)) {
      const hasSettings = entry.disabled || entry.toolAllowlist !== undefined;

      if (entry.transport === "stdio") {
        if (!hasSettings) {
          output[name] = entry.command;
          continue;
        }

        const obj: Record<string, unknown> = {
          command: entry.command,
        };
        if (entry.disabled) obj.disabled = true;
        if (entry.toolAllowlist !== undefined) obj.toolAllowlist = entry.toolAllowlist;
        output[name] = obj;
        continue;
      }

      const obj: Record<string, unknown> = {
        transport: entry.transport,
        url: entry.url,
      };
      if (entry.headers) obj.headers = entry.headers;
      if (entry.disabled) obj.disabled = true;
      if (entry.toolAllowlist !== undefined) obj.toolAllowlist = entry.toolAllowlist;

      output[name] = obj;
    }

    await writeFileAtomic(filePath, JSON.stringify({ servers: output }, null, 2), "utf-8");
  }

  private async getGlobalConfig(): Promise<MCPConfig> {
    const filePath = this.getGlobalConfigPath();

    try {
      const exists = await this.pathExists(filePath);
      if (!exists) {
        return { servers: {} };
      }

      const raw = await fs.promises.readFile(filePath, "utf-8");
      const errors: jsonc.ParseError[] = [];
      const parsed = jsonc.parse(raw, errors) as { servers?: Record<string, unknown> } | undefined;

      if (errors.length > 0) {
        this.logParseErrorsOnce(filePath, errors);
        return { servers: {} };
      }

      if (!parsed || typeof parsed !== "object" || !parsed.servers) {
        return { servers: {} };
      }

      // Normalize all entries on read.
      const servers: Record<string, MCPServerInfo> = {};
      for (const [name, entry] of Object.entries(parsed.servers)) {
        servers[name] = this.normalizeEntry(entry);
      }

      return { servers };
    } catch (error) {
      log.error("[MCP] Failed to read global MCP config", { filePath, error });
      return { servers: {} };
    }
  }

  private async saveGlobalConfig(config: MCPConfig): Promise<void> {
    // Global MCP config lives in ~/.mux (Config.rootDir); ensure it exists for new installs/tests.
    await fs.promises.mkdir(this.config.rootDir, { recursive: true });

    const filePath = this.getGlobalConfigPath();

    // Write minimal format:
    // - string for stdio servers without extra settings
    // - object when:
    //   - disabled/toolAllowlist set, or
    //   - non-stdio transport, or
    //   - headers present
    //
    // toolAllowlist: undefined = all tools (omit), [] = no tools, [...] = those tools
    const output: Record<string, unknown> = {};

    for (const [name, entry] of Object.entries(config.servers)) {
      const hasSettings = entry.disabled || entry.toolAllowlist !== undefined;

      if (entry.transport === "stdio") {
        if (!hasSettings) {
          output[name] = entry.command;
          continue;
        }

        const obj: Record<string, unknown> = {
          command: entry.command,
        };
        if (entry.disabled) obj.disabled = true;
        if (entry.toolAllowlist !== undefined) obj.toolAllowlist = entry.toolAllowlist;
        output[name] = obj;
        continue;
      }

      const obj: Record<string, unknown> = {
        transport: entry.transport,
        url: entry.url,
      };
      if (entry.headers) obj.headers = entry.headers;
      if (entry.disabled) obj.disabled = true;
      if (entry.toolAllowlist !== undefined) obj.toolAllowlist = entry.toolAllowlist;

      output[name] = obj;
    }

    await writeFileAtomic(filePath, JSON.stringify({ servers: output }, null, 2), "utf-8");
  }

  private async getConfigDiagnostics(filePath: string): Promise<MCPConfigDiagnostics> {
    try {
      const exists = await this.pathExists(filePath);
      if (!exists) {
        return { filePath, parseErrors: [], validationErrors: [] };
      }

      const raw = await fs.promises.readFile(filePath, "utf-8");
      const errors: jsonc.ParseError[] = [];
      const parsed = jsonc.parse(raw, errors) as { servers?: Record<string, unknown> } | undefined;

      const parseErrors: MCPConfigDiagnostics["parseErrors"] = errors.map((error) => ({
        message: jsonc.printParseErrorCode(error.error),
        offset: error.offset,
        length: error.length,
      }));

      if (errors.length > 0) {
        return { filePath, parseErrors, validationErrors: [] };
      }

      if (!parsed || typeof parsed !== "object" || !parsed.servers) {
        return { filePath, parseErrors: [], validationErrors: [] };
      }

      const servers: Record<string, MCPServerInfo> = {};
      for (const [name, entry] of Object.entries(parsed.servers)) {
        servers[name] = this.normalizeEntry(entry);
      }

      return {
        filePath,
        parseErrors: [],
        validationErrors: this.validateServers(servers),
      };
    } catch (error) {
      return {
        filePath,
        parseErrors: [
          {
            message: error instanceof Error ? error.message : String(error),
            offset: 0,
            length: 0,
          },
        ],
        validationErrors: [],
      };
    }
  }

  async getProjectConfigDiagnostics(projectPath: string): Promise<MCPConfigDiagnostics> {
    return this.getConfigDiagnostics(this.getProjectConfigPath(projectPath));
  }

  async getGlobalConfigDiagnostics(): Promise<MCPConfigDiagnostics> {
    return this.getConfigDiagnostics(this.getGlobalConfigPath());
  }
  /** List all servers with normalized config */
  async listServers(projectPath: string): Promise<Record<string, MCPServerInfo>> {
    const cfg = await this.getConfig(projectPath);
    return cfg.servers;
  }

  async addServer(
    projectPath: string,
    name: string,
    input: {
      transport?: MCPServerTransport;
      command?: string;
      url?: string;
      headers?: Record<string, MCPHeaderValue>;
    }
  ): Promise<Result<void>> {
    if (!name.trim()) {
      return Err("Server name is required");
    }

    const transport: MCPServerTransport = input.transport ?? "stdio";

    if (transport === "stdio") {
      if (!input.command?.trim()) {
        return Err("Command is required");
      }
    } else {
      if (!input.url?.trim()) {
        return Err("URL is required");
      }
    }

    const cfg = await this.getConfig(projectPath);
    const existing = cfg.servers[name];

    const base = {
      disabled: existing?.disabled ?? false,
      toolAllowlist: existing?.toolAllowlist,
    };

    const next: MCPServerInfo =
      transport === "stdio"
        ? {
            transport: "stdio",
            command: input.command!,
            ...base,
          }
        : {
            transport,
            url: input.url!,
            headers: input.headers,
            ...base,
          };

    cfg.servers[name] = next;

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

  async setToolAllowlist(
    projectPath: string,
    name: string,
    toolAllowlist: string[]
  ): Promise<Result<void>> {
    const cfg = await this.getConfig(projectPath);
    const entry = cfg.servers[name];
    if (!entry) {
      return Err(`Server ${name} not found`);
    }
    // [] = no tools allowed, [...tools] = those tools allowed
    cfg.servers[name] = {
      ...entry,
      toolAllowlist,
    };
    try {
      await this.saveConfig(projectPath, cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to update MCP server tool allowlist", { projectPath, name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Global MCP servers (~/.mux/mcp.jsonc)
  // ---------------------------------------------------------------------------

  async listGlobalServers(): Promise<Record<string, MCPServerInfo>> {
    const cfg = await this.getGlobalConfig();
    return cfg.servers;
  }

  async addGlobalServer(
    name: string,
    input: {
      transport?: MCPServerTransport;
      command?: string;
      url?: string;
      headers?: Record<string, MCPHeaderValue>;
    }
  ): Promise<Result<void>> {
    if (!name.trim()) {
      return Err("Server name is required");
    }

    const transport: MCPServerTransport = input.transport ?? "stdio";

    if (transport === "stdio") {
      if (!input.command?.trim()) {
        return Err("Command is required");
      }
    } else {
      if (!input.url?.trim()) {
        return Err("URL is required");
      }
    }

    const cfg = await this.getGlobalConfig();
    const existing = cfg.servers[name];

    const base = {
      disabled: existing?.disabled ?? false,
      toolAllowlist: existing?.toolAllowlist,
    };

    const next: MCPServerInfo =
      transport === "stdio"
        ? {
            transport: "stdio",
            command: input.command!,
            ...base,
          }
        : {
            transport,
            url: input.url!,
            headers: input.headers,
            ...base,
          };

    cfg.servers[name] = next;

    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("[MCP] Failed to save global MCP server", { name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }

  async setGlobalServerEnabled(name: string, enabled: boolean): Promise<Result<void>> {
    const cfg = await this.getGlobalConfig();
    const entry = cfg.servers[name];
    if (!entry) {
      return Err(`Server ${name} not found`);
    }

    cfg.servers[name] = { ...entry, disabled: !enabled };

    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("[MCP] Failed to update global MCP server enabled state", { name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }

  async removeGlobalServer(name: string): Promise<Result<void>> {
    const cfg = await this.getGlobalConfig();
    if (!cfg.servers[name]) {
      return Err(`Server ${name} not found`);
    }

    delete cfg.servers[name];

    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("[MCP] Failed to remove global MCP server", { name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }

  async setGlobalToolAllowlist(name: string, toolAllowlist: string[]): Promise<Result<void>> {
    const cfg = await this.getGlobalConfig();
    const entry = cfg.servers[name];
    if (!entry) {
      return Err(`Server ${name} not found`);
    }

    // [] = no tools allowed, [...tools] = those tools allowed
    cfg.servers[name] = {
      ...entry,
      toolAllowlist,
    };

    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("[MCP] Failed to update global MCP server tool allowlist", { name, error });
      return Err(error instanceof Error ? error.message : String(error));
    }
  }
}
