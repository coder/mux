import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { getErrorMessage } from "@/common/utils/errors";
import type { AgentBrowserSessionDiscoveryService } from "./AgentBrowserSessionDiscoveryService";
import { DisposableProcess } from "@/node/utils/disposableExec";

const CONTROL_COMMAND_TIMEOUT_MS = 15_000;
const BROWSER_CONTROL_ACTIONS = ["open", "back", "forward", "reload"] as const;

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type BrowserControlAction = (typeof BROWSER_CONTROL_ACTIONS)[number];

export interface BrowserControlParams {
  workspaceId: string;
  sessionName: string;
  action: BrowserControlAction;
  url?: string | null;
}

export interface BrowserControlResult {
  success: boolean;
  error?: string;
}

export interface BrowserGetUrlResult {
  url: string | null;
  error?: string;
}

export interface BrowserGetUrlOptions {
  skipSessionValidation?: boolean;
}

interface BrowserCommandExecutionResult {
  success: boolean;
  stdout: string;
  error?: string;
}

interface BrowserControlServiceOptions {
  browserSessionDiscoveryService: Pick<AgentBrowserSessionDiscoveryService, "getSessionConnection">;
  resolveSessionEnvFn?: (workspaceId: string) => Promise<NodeJS.ProcessEnv>;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}

export class BrowserControlService {
  private readonly browserSessionDiscoveryService: BrowserControlServiceOptions["browserSessionDiscoveryService"];
  private readonly resolveSessionEnvFn: (workspaceId: string) => Promise<NodeJS.ProcessEnv>;
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;

  constructor(options: BrowserControlServiceOptions) {
    assert(
      options.browserSessionDiscoveryService,
      "BrowserControlService requires a browserSessionDiscoveryService"
    );

    this.browserSessionDiscoveryService = options.browserSessionDiscoveryService;
    this.resolveSessionEnvFn = options.resolveSessionEnvFn ?? (() => Promise.resolve(process.env));
    this.spawnFn = options.spawnFn ?? spawn;
    this.timeoutMs = options.timeoutMs ?? CONTROL_COMMAND_TIMEOUT_MS;
    assert(this.timeoutMs > 0, "BrowserControlService timeoutMs must be positive");
  }

  async executeControl(params: BrowserControlParams): Promise<BrowserControlResult> {
    this.assertValidControlParams(params);

    try {
      const connection = await this.browserSessionDiscoveryService.getSessionConnection(
        params.workspaceId,
        params.sessionName
      );
      if (connection == null) {
        return {
          success: false,
          error: `Session "${params.sessionName}" not found for workspace "${params.workspaceId}"`,
        };
      }

      assert(
        connection.sessionName === params.sessionName,
        "BrowserControlService resolved session must match the requested session name"
      );

      const execution = await this.runAgentBrowserCommand(
        params.workspaceId,
        this.buildControlArgs(params),
        `agent-browser ${params.action} for session ${params.sessionName}`
      );
      if (!execution.success) {
        return {
          success: false,
          error: execution.error,
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  async getUrl(
    workspaceId: string,
    sessionName: string,
    options?: BrowserGetUrlOptions
  ): Promise<BrowserGetUrlResult> {
    this.assertValidSessionIdentifiers(workspaceId, sessionName);
    assert(
      options == null || typeof options === "object",
      "BrowserControlService getUrl options must be an object when provided"
    );
    assert(
      options?.skipSessionValidation == null || typeof options.skipSessionValidation === "boolean",
      "BrowserControlService getUrl skipSessionValidation must be a boolean when provided"
    );

    try {
      if (!options?.skipSessionValidation) {
        const connection = await this.browserSessionDiscoveryService.getSessionConnection(
          workspaceId,
          sessionName
        );
        if (connection == null) {
          return {
            url: null,
            error: `Session "${sessionName}" not found for workspace "${workspaceId}"`,
          };
        }

        assert(
          connection.sessionName === sessionName,
          "BrowserControlService resolved session must match the requested session name"
        );
      }

      const execution = await this.runAgentBrowserCommand(
        workspaceId,
        ["--session", sessionName, "get", "url"],
        `agent-browser get url for session ${sessionName}`
      );
      if (!execution.success) {
        return {
          url: null,
          error: execution.error,
        };
      }

      const trimmedUrl = execution.stdout.trim();
      return { url: trimmedUrl.length > 0 ? trimmedUrl : null };
    } catch (error) {
      return {
        url: null,
        error: getErrorMessage(error),
      };
    }
  }

  private assertValidControlParams(params: BrowserControlParams): void {
    this.assertValidSessionIdentifiers(params.workspaceId, params.sessionName);
    assert(
      BROWSER_CONTROL_ACTIONS.includes(params.action),
      `Unsupported browser control action: ${String(params.action)}`
    );

    if (params.action === "open") {
      assert(typeof params.url === "string", 'BrowserControlService "open" requires a url');
      assert(params.url.trim().length > 0, 'BrowserControlService "open" requires a non-empty url');
      return;
    }

    assert(
      params.url == null,
      `BrowserControlService action "${params.action}" does not accept a url`
    );
  }

  private assertValidSessionIdentifiers(workspaceId: string, sessionName: string): void {
    assert(workspaceId.trim().length > 0, "BrowserControlService requires a non-empty workspaceId");
    assert(sessionName.trim().length > 0, "BrowserControlService requires a non-empty sessionName");
  }

  private buildControlArgs(params: BrowserControlParams): string[] {
    switch (params.action) {
      case "open":
        return ["--session", params.sessionName, "open", params.url!.trim()];
      case "back":
      case "forward":
      case "reload":
        return ["--session", params.sessionName, params.action];
      default:
        assert(false, `Unsupported browser control action: ${String(params.action)}`);
    }
  }

  private async runAgentBrowserCommand(
    workspaceId: string,
    args: string[],
    commandDescription: string
  ): Promise<BrowserCommandExecutionResult> {
    const env = await this.resolveSessionEnvFn(workspaceId);

    return await new Promise<BrowserCommandExecutionResult>((resolve) => {
      let childProcess: ChildProcess;
      try {
        childProcess = this.spawnFn("agent-browser", args, {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        resolve({ success: false, stdout: "", error: getErrorMessage(error) });
        return;
      }

      const disposableProcess = new DisposableProcess(childProcess);
      let settled = false;
      let stdout = "";
      let stderr = "";

      const finish = (result: BrowserCommandExecutionResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        disposableProcess[Symbol.dispose]();
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        finish({
          success: false,
          stdout,
          error: `${commandDescription} timed out after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);
      timeoutId.unref?.();

      childProcess.stdout?.setEncoding("utf8");
      childProcess.stderr?.setEncoding("utf8");
      childProcess.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      childProcess.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      childProcess.once("error", (error) => {
        finish({ success: false, stdout, error: getErrorMessage(error) });
      });

      childProcess.once("close", (code, signal) => {
        if (code !== 0 || signal !== null) {
          finish({
            success: false,
            stdout,
            error: stderr.trim() || `${commandDescription} exited with ${String(signal ?? code)}`,
          });
          return;
        }

        finish({ success: true, stdout });
      });
    });
  }
}
