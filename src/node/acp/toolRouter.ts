import assert from "node:assert/strict";
import type {
  AgentSideConnection,
  EnvVariable,
  PermissionOption,
  RequestPermissionOutcome,
} from "@agentclientprotocol/sdk";
import type { RuntimeMode } from "../../common/types/runtime";

// Defined locally while ACP capability negotiation modules are developed.
interface NegotiatedCapabilities {
  editorSupportsFsRead: boolean;
  editorSupportsFsWrite: boolean;
  editorSupportsTerminal: boolean;
}

interface SessionRouting {
  workspaceId: string;
  runtimeMode: RuntimeMode;
  editorHandlesFs: boolean;
  editorHandlesTerminal: boolean;
}

const FILE_READ_TOOL_NAMES = new Set([
  "file_read",
  "file-read",
  "file.read",
  "read_file",
  "read-file",
  "fs/read_text_file",
]);

const FILE_WRITE_TOOL_NAMES = new Set([
  "file_write",
  "file-write",
  "file.write",
  "write_file",
  "write-file",
  "fs/write_text_file",
]);

const TERMINAL_TOOL_NAMES = new Set(["bash", "terminal/create", "terminal.run", "terminal_run"]);

export class ToolRouter {
  private editorCapabilities: NegotiatedCapabilities | null = null;
  private sessionRouting = new Map<string, SessionRouting>();

  constructor(private readonly connection: AgentSideConnection) {
    assert(connection != null, "ToolRouter: connection is required");
  }

  setEditorCapabilities(caps: NegotiatedCapabilities): void {
    assert(
      typeof caps.editorSupportsFsRead === "boolean",
      "setEditorCapabilities: editorSupportsFsRead must be boolean"
    );
    assert(
      typeof caps.editorSupportsFsWrite === "boolean",
      "setEditorCapabilities: editorSupportsFsWrite must be boolean"
    );
    assert(
      typeof caps.editorSupportsTerminal === "boolean",
      "setEditorCapabilities: editorSupportsTerminal must be boolean"
    );

    this.editorCapabilities = caps;

    for (const [sessionId, routing] of this.sessionRouting) {
      const isLocal = routing.runtimeMode === "local";
      this.sessionRouting.set(sessionId, {
        ...routing,
        editorHandlesFs: isLocal && this.supportsAnyFsCapability(caps),
        editorHandlesTerminal: isLocal && caps.editorSupportsTerminal,
      });
    }
  }

  registerSession(sessionId: string, runtimeMode: RuntimeMode): void {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "registerSession: sessionId must be non-empty"
    );

    const isLocal = runtimeMode === "local";
    const editorCaps = this.editorCapabilities;
    this.sessionRouting.set(sessionId, {
      workspaceId: sessionId,
      runtimeMode,
      editorHandlesFs: isLocal && this.supportsAnyFsCapability(editorCaps),
      editorHandlesTerminal: isLocal && (editorCaps?.editorSupportsTerminal ?? false),
    });
  }

  shouldDelegateToEditor(sessionId: string, toolName: string): boolean {
    const routing = this.sessionRouting.get(sessionId);
    if (routing == null) {
      return false;
    }

    const normalizedToolName = normalizeToolName(toolName);

    if (isFilesystemTool(normalizedToolName)) {
      return routing.editorHandlesFs;
    }

    if (isTerminalTool(normalizedToolName)) {
      return routing.editorHandlesTerminal;
    }

    return false;
  }

  async delegateToEditor(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "delegateToEditor: sessionId must be non-empty"
    );
    assert(
      typeof toolName === "string" && toolName.trim().length > 0,
      "delegateToEditor: toolName must be non-empty"
    );
    assert(isPlainObject(params), "delegateToEditor: params must be an object");

    if (!this.shouldDelegateToEditor(sessionId, toolName)) {
      throw new Error(
        `ToolRouter: tool ${toolName} is not delegated to editor for session ${sessionId}`
      );
    }

    const normalizedToolName = normalizeToolName(toolName);

    if (isTypedReadTool(normalizedToolName)) {
      return this.connection.readTextFile(
        this.buildReadTextFileRequest(sessionId, params, toolName)
      );
    }

    if (isTypedWriteTool(normalizedToolName)) {
      return this.connection.writeTextFile(
        this.buildWriteTextFileRequest(sessionId, params, toolName)
      );
    }

    if (isTerminalTool(normalizedToolName)) {
      const terminal = await this.connection.createTerminal(
        this.buildCreateTerminalRequest(sessionId, params, toolName)
      );
      return { terminalId: terminal.id };
    }

    return this.connection.extMethod(toolName, {
      sessionId,
      ...params,
    });
  }

  async requestPermission(
    sessionId: string,
    toolCallId: string,
    description: string
  ): Promise<boolean> {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "requestPermission: sessionId must be non-empty"
    );
    assert(
      typeof toolCallId === "string" && toolCallId.trim().length > 0,
      "requestPermission: toolCallId must be non-empty"
    );
    assert(
      typeof description === "string" && description.trim().length > 0,
      "requestPermission: description must be non-empty"
    );

    const options: PermissionOption[] = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" },
      { optionId: "reject_always", name: "Always deny", kind: "reject_always" },
    ];

    const response = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId,
        title: description,
        status: "pending",
      },
      options,
    });

    return this.isPermissionAllowed(response.outcome);
  }

  private supportsAnyFsCapability(caps: NegotiatedCapabilities | null): boolean {
    if (caps == null) {
      return false;
    }
    return caps.editorSupportsFsRead || caps.editorSupportsFsWrite;
  }

  private buildReadTextFileRequest(
    sessionId: string,
    params: Record<string, unknown>,
    toolName: string
  ): { sessionId: string; path: string; line?: number; limit?: number } {
    const path = getRequiredString(params, "path", toolName);
    const line =
      getOptionalNumber(params, "line", toolName) ?? getOptionalNumber(params, "offset", toolName);
    const limit = getOptionalNumber(params, "limit", toolName);

    return {
      sessionId,
      path,
      line,
      limit,
    };
  }

  private buildWriteTextFileRequest(
    sessionId: string,
    params: Record<string, unknown>,
    toolName: string
  ): { sessionId: string; path: string; content: string } {
    const path = getRequiredString(params, "path", toolName);
    const content = getRequiredString(params, "content", toolName);

    return {
      sessionId,
      path,
      content,
    };
  }

  private buildCreateTerminalRequest(
    sessionId: string,
    params: Record<string, unknown>,
    toolName: string
  ): {
    sessionId: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: EnvVariable[];
    outputByteLimit?: number;
  } {
    if (normalizeToolName(toolName) === "bash") {
      const script = getScriptFromParams(params, toolName);
      const cwd = getOptionalString(params, "cwd", toolName);
      const outputByteLimit = getOptionalNumber(params, "outputByteLimit", toolName);
      const env = getOptionalEnvVariables(params, "env", toolName);
      return {
        sessionId,
        command: "bash",
        args: ["-lc", script],
        cwd,
        env,
        outputByteLimit,
      };
    }

    const command = getRequiredString(params, "command", toolName);
    const args = getOptionalStringArray(params, "args", toolName);
    const cwd = getOptionalString(params, "cwd", toolName);
    const outputByteLimit = getOptionalNumber(params, "outputByteLimit", toolName);
    const env = getOptionalEnvVariables(params, "env", toolName);

    return {
      sessionId,
      command,
      args,
      cwd,
      env,
      outputByteLimit,
    };
  }

  private isPermissionAllowed(outcome: RequestPermissionOutcome): boolean {
    if (outcome.outcome === "cancelled") {
      return false;
    }

    const selectedOptionId = outcome.optionId;
    return selectedOptionId === "allow_once" || selectedOptionId === "allow_always";
  }
}

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function isFilesystemTool(normalizedToolName: string): boolean {
  return (
    normalizedToolName.startsWith("fs/") ||
    normalizedToolName.startsWith("file_") ||
    FILE_READ_TOOL_NAMES.has(normalizedToolName) ||
    FILE_WRITE_TOOL_NAMES.has(normalizedToolName)
  );
}

function isTerminalTool(normalizedToolName: string): boolean {
  return normalizedToolName.startsWith("terminal/") || TERMINAL_TOOL_NAMES.has(normalizedToolName);
}

function isTypedReadTool(normalizedToolName: string): boolean {
  return FILE_READ_TOOL_NAMES.has(normalizedToolName);
}

function isTypedWriteTool(normalizedToolName: string): boolean {
  return FILE_WRITE_TOOL_NAMES.has(normalizedToolName);
}

function getScriptFromParams(params: Record<string, unknown>, toolName: string): string {
  const scriptValue = params.script;
  if (typeof scriptValue === "string" && scriptValue.trim().length > 0) {
    return scriptValue;
  }

  const commandValue = params.command;
  if (typeof commandValue === "string" && commandValue.trim().length > 0) {
    return commandValue;
  }

  throw new Error(`ToolRouter: ${toolName} requires a non-empty script or command parameter`);
}

function getRequiredString(params: Record<string, unknown>, key: string, toolName: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`ToolRouter: ${toolName} requires a non-empty string parameter '${key}'`);
  }
  return value;
}

function getOptionalString(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): string | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`ToolRouter: ${toolName} parameter '${key}' must be a string when provided`);
  }
  return value;
}

function getOptionalNumber(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): number | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `ToolRouter: ${toolName} parameter '${key}' must be a finite number when provided`
    );
  }
  return value;
}

function getOptionalStringArray(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): string[] | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `ToolRouter: ${toolName} parameter '${key}' must be an array of strings when provided`
    );
  }

  const stringValues: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `ToolRouter: ${toolName} parameter '${key}' must be an array of strings when provided`
      );
    }

    stringValues.push(entry);
  }

  return stringValues;
}

function getOptionalEnvVariables(
  params: Record<string, unknown>,
  key: string,
  toolName: string
): EnvVariable[] | undefined {
  const value = params[key];
  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const envVariables: EnvVariable[] = [];
    for (const entry of value) {
      if (!isPlainObject(entry)) {
        throw new Error(
          `ToolRouter: ${toolName} parameter '${key}' must be an array of {name, value} objects when provided`
        );
      }
      const name = entry.name;
      const envValue = entry.value;
      if (typeof name !== "string" || typeof envValue !== "string") {
        throw new Error(
          `ToolRouter: ${toolName} env entries must include string 'name' and 'value'`
        );
      }
      envVariables.push({ name, value: envValue });
    }
    return envVariables;
  }

  if (isPlainObject(value)) {
    const envVariables: EnvVariable[] = [];
    for (const [name, envValue] of Object.entries(value)) {
      if (typeof envValue !== "string") {
        throw new Error(`ToolRouter: ${toolName} env object values must be strings`);
      }
      envVariables.push({ name, value: envValue });
    }
    return envVariables;
  }

  throw new Error(
    `ToolRouter: ${toolName} parameter '${key}' must be an array of entries or object map when provided`
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
