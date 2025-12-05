import { EventEmitter } from "events";
import { spawn } from "child_process";
import type { Config } from "@/node/config";
import type { PTYService } from "@/node/services/ptyService";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import type {
  TerminalSession,
  TerminalCreateParams,
  TerminalResizeParams,
} from "@/common/types/terminal";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import { log } from "@/node/services/log";
import { isCommandAvailable, findAvailableCommand } from "@/node/utils/commandDiscovery";

/**
 * Configuration for opening a native terminal
 */
type NativeTerminalConfig =
  | { type: "local"; workspacePath: string; command?: string }
  | {
      type: "ssh";
      sshConfig: Extract<RuntimeConfig, { type: "ssh" }>;
      remotePath: string;
      command?: string;
    };

export class TerminalService {
  private readonly config: Config;
  private readonly ptyService: PTYService;
  private terminalWindowManager?: TerminalWindowManager;

  // Event emitters for each session
  private readonly outputEmitters = new Map<string, EventEmitter>();
  private readonly exitEmitters = new Map<string, EventEmitter>();

  // Buffer for initial output to handle race condition between create and subscribe
  // Map<sessionId, string[]>
  private readonly outputBuffers = new Map<string, string[]>();
  private readonly MAX_BUFFER_SIZE = 50; // Keep last 50 chunks

  constructor(config: Config, ptyService: PTYService) {
    this.config = config;
    this.ptyService = ptyService;
  }

  setTerminalWindowManager(manager: TerminalWindowManager) {
    this.terminalWindowManager = manager;
  }

  /**
   * Check if we're running in desktop mode (Electron) vs server mode (browser).
   */
  isDesktopMode(): boolean {
    return !!this.terminalWindowManager;
  }

  async create(params: TerminalCreateParams): Promise<TerminalSession> {
    try {
      // 1. Resolve workspace
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspaceMetadata = allMetadata.find((w) => w.id === params.workspaceId);

      if (!workspaceMetadata) {
        throw new Error(`Workspace not found: ${params.workspaceId}`);
      }

      // 2. Create runtime
      const runtime = createRuntime(
        workspaceMetadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir }
      );

      // 3. Compute workspace path
      const workspacePath = runtime.getWorkspacePath(
        workspaceMetadata.projectPath,
        workspaceMetadata.name
      );

      // 4. Setup emitters and buffer
      // We don't know the sessionId yet (PTYService generates it), but PTYService uses a callback.
      // We need to capture the sessionId.
      // Actually PTYService returns the session object with ID.
      // But the callbacks are passed IN to createSession.
      // So we need a way to map the callback to the future sessionId.

      // Hack: We'll create a temporary object to hold the emitter/buffer and assign it to the map once we have the ID.
      // But the callback runs *after* creation usually (when data comes).
      // However, it's safer to create the emitter *before* passing callbacks if we can.
      // We can't key it by sessionId yet.

      let tempSessionId: string | null = null;
      const localBuffer: string[] = [];

      const onData = (data: string) => {
        if (tempSessionId) {
          this.emitOutput(tempSessionId, data);
        } else {
          // Buffer data if session ID is not yet available (race condition during creation)
          localBuffer.push(data);
        }
      };

      const onExit = (code: number) => {
        if (tempSessionId) {
          const emitter = this.exitEmitters.get(tempSessionId);
          emitter?.emit("exit", code);
          this.cleanup(tempSessionId);
        }
      };

      // 5. Create session
      const session = await this.ptyService.createSession(
        params,
        runtime,
        workspacePath,
        onData,
        onExit
      );

      tempSessionId = session.sessionId;

      // Initialize emitters
      this.outputEmitters.set(session.sessionId, new EventEmitter());
      this.exitEmitters.set(session.sessionId, new EventEmitter());
      this.outputBuffers.set(session.sessionId, []);

      // Replay local buffer that arrived during creation
      for (const data of localBuffer) {
        this.emitOutput(session.sessionId, data);
      }

      // Send initial command if provided
      if (params.initialCommand) {
        this.sendInput(session.sessionId, `${params.initialCommand}\n`);
      }

      return session;
    } catch (err) {
      log.error("Error creating terminal session:", err);
      throw err;
    }
  }

  close(sessionId: string): void {
    try {
      this.ptyService.closeSession(sessionId);
      this.cleanup(sessionId);
    } catch (err) {
      log.error("Error closing terminal session:", err);
      throw err;
    }
  }

  resize(params: TerminalResizeParams): void {
    try {
      this.ptyService.resize(params);
    } catch (err) {
      log.error("Error resizing terminal:", err);
      throw err;
    }
  }

  sendInput(sessionId: string, data: string): void {
    try {
      this.ptyService.sendInput(sessionId, data);
    } catch (err) {
      log.error(`Error sending input to terminal ${sessionId}:`, err);
      throw err;
    }
  }

  async openWindow(workspaceId: string): Promise<void> {
    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspace = allMetadata.find((w) => w.id === workspaceId);

      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      const runtimeConfig = workspace.runtimeConfig;
      const isSSH = isSSHRuntime(runtimeConfig);
      const isDesktop = !!this.terminalWindowManager;

      if (isDesktop) {
        log.info(`Opening terminal window for workspace: ${workspaceId}`);
        await this.terminalWindowManager!.openTerminalWindow(workspaceId);
      } else {
        log.info(
          `Browser mode: terminal UI handled by browser for ${isSSH ? "SSH" : "local"} workspace: ${workspaceId}`
        );
      }
    } catch (err) {
      log.error("Error opening terminal window:", err);
      throw err;
    }
  }

  closeWindow(workspaceId: string): void {
    try {
      if (!this.terminalWindowManager) {
        // Not an error in server mode, just no-op
        return;
      }
      this.terminalWindowManager.closeTerminalWindow(workspaceId);
    } catch (err) {
      log.error("Error closing terminal window:", err);
      throw err;
    }
  }

  /**
   * Open the native system terminal for a workspace.
   * Opens the user's preferred terminal emulator (Ghostty, Terminal.app, etc.)
   * with the working directory set to the workspace path.
   *
   * For SSH workspaces, opens a terminal that SSHs into the remote host.
   */
  async openNative(workspaceId: string): Promise<void> {
    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspace = allMetadata.find((w) => w.id === workspaceId);

      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      const runtimeConfig = workspace.runtimeConfig;

      if (isSSHRuntime(runtimeConfig)) {
        // SSH workspace - spawn local terminal that SSHs into remote host
        await this.openNativeTerminal({
          type: "ssh",
          sshConfig: runtimeConfig,
          remotePath: workspace.namedWorkspacePath,
        });
      } else {
        // Local workspace - spawn terminal with cwd set
        await this.openNativeTerminal({
          type: "local",
          workspacePath: workspace.namedWorkspacePath,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to open native terminal: ${message}`);
      throw err;
    }
  }

  /**
   * Open a native terminal and run a command.
   * Used for opening $EDITOR in a terminal when editing files.
   * @param command The command to run
   * @param workspacePath Optional directory to run the command in (defaults to cwd)
   */
  async openNativeWithCommand(command: string, workspacePath?: string): Promise<void> {
    await this.openNativeTerminal({
      type: "local",
      workspacePath: workspacePath ?? process.cwd(),
      command,
    });
  }

  /**
   * Open a native terminal (local or SSH) with platform-specific handling.
   * This spawns the user's native terminal emulator, not a web-based terminal.
   */
  private async openNativeTerminal(config: NativeTerminalConfig): Promise<void> {
    const isSSH = config.type === "ssh";

    // Build SSH args if needed
    let sshArgs: string[] | null = null;
    if (isSSH) {
      sshArgs = [];
      // Add port if specified
      if (config.sshConfig.port) {
        sshArgs.push("-p", String(config.sshConfig.port));
      }
      // Add identity file if specified
      if (config.sshConfig.identityFile) {
        sshArgs.push("-i", config.sshConfig.identityFile);
      }
      // Force pseudo-terminal allocation
      sshArgs.push("-t");
      // Add host
      sshArgs.push(config.sshConfig.host);
      // Add remote command to cd into directory and start shell
      // Use single quotes to prevent local shell expansion
      // exec $SHELL replaces the SSH process with the shell, avoiding nested processes
      sshArgs.push(`cd '${config.remotePath.replace(/'/g, "'\\''")}' && exec $SHELL`);
    }

    const logPrefix = isSSH ? "SSH terminal" : "terminal";

    if (process.platform === "darwin") {
      await this.openNativeTerminalMacOS(config, sshArgs, logPrefix);
    } else if (process.platform === "win32") {
      this.openNativeTerminalWindows(config, sshArgs, logPrefix);
    } else {
      await this.openNativeTerminalLinux(config, sshArgs, logPrefix);
    }
  }

  private async openNativeTerminalMacOS(
    config: NativeTerminalConfig,
    sshArgs: string[] | null,
    logPrefix: string
  ): Promise<void> {
    const isSSH = config.type === "ssh";
    const command = config.command;
    const workspacePath = config.type === "local" ? config.workspacePath : config.remotePath;

    // macOS - try Ghostty first, fallback to Terminal.app
    const terminal = await findAvailableCommand(["ghostty", "terminal"]);
    if (terminal === "ghostty") {
      const cmd = "open";
      let args: string[];
      if (isSSH && sshArgs) {
        // Ghostty: Use --command flag to run SSH
        // Build the full SSH command as a single string
        const sshCommand = ["ssh", ...sshArgs].join(" ");
        args = ["-n", "-a", "Ghostty", "--args", `--command=${sshCommand}`];
      } else if (command) {
        // Ghostty: Run command in workspace directory
        // Wrap in sh -c to handle cd and command properly
        const escapedPath = workspacePath.replace(/'/g, "'\\''");
        const escapedCmd = command.replace(/'/g, "'\\''");
        const fullCommand = `sh -c 'cd "${escapedPath}" && ${escapedCmd}'`;
        args = ["-n", "-a", "Ghostty", "--args", `--command=${fullCommand}`];
      } else {
        // Ghostty: Pass workspacePath to 'open -a Ghostty' to avoid regressions
        args = ["-a", "Ghostty", workspacePath];
      }
      log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else {
      // Terminal.app
      const cmd = isSSH || command ? "osascript" : "open";
      let args: string[];
      if (isSSH && sshArgs) {
        // Terminal.app: Use osascript with proper AppleScript structure
        // Properly escape single quotes in args before wrapping in quotes
        const sshCommand = `ssh ${sshArgs
          .map((arg) => {
            if (arg.includes(" ") || arg.includes("'")) {
              // Escape single quotes by ending quote, adding escaped quote, starting quote again
              return `'${arg.replace(/'/g, "'\\''")}'`;
            }
            return arg;
          })
          .join(" ")}`;
        // Escape double quotes for AppleScript string
        const escapedCommand = sshCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Terminal"\nactivate\ndo script "${escapedCommand}"\nend tell`;
        args = ["-e", script];
      } else if (command) {
        // Terminal.app: Run command in workspace directory via AppleScript
        const fullCommand = `cd "${workspacePath}" && ${command}`;
        const escapedCommand = fullCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "Terminal"\nactivate\ndo script "${escapedCommand}"\nend tell`;
        args = ["-e", script];
      } else {
        // Terminal.app opens in the directory when passed as argument
        args = ["-a", "Terminal", workspacePath];
      }
      log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
  }

  private openNativeTerminalWindows(
    config: NativeTerminalConfig,
    sshArgs: string[] | null,
    logPrefix: string
  ): void {
    const isSSH = config.type === "ssh";
    const command = config.command;
    const workspacePath = config.type === "local" ? config.workspacePath : config.remotePath;

    // Windows
    const cmd = "cmd";
    let args: string[];
    if (isSSH && sshArgs) {
      // Windows - use cmd to start ssh
      args = ["/c", "start", "cmd", "/K", "ssh", ...sshArgs];
    } else if (command) {
      // Windows - cd to directory and run command
      args = ["/c", "start", "cmd", "/K", `cd /D "${workspacePath}" && ${command}`];
    } else {
      // Windows - just cd to directory
      args = ["/c", "start", "cmd", "/K", "cd", "/D", workspacePath];
    }
    log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      detached: true,
      shell: true,
      stdio: "ignore",
    });
    child.unref();
  }

  private async openNativeTerminalLinux(
    config: NativeTerminalConfig,
    sshArgs: string[] | null,
    logPrefix: string
  ): Promise<void> {
    const isSSH = config.type === "ssh";
    const command = config.command;
    const workspacePath = config.type === "local" ? config.workspacePath : config.remotePath;

    // Linux - try terminal emulators in order of preference
    let terminals: Array<{ cmd: string; args: string[]; cwd?: string }>;

    if (isSSH && sshArgs) {
      // x-terminal-emulator is checked first as it respects user's system-wide preference
      terminals = [
        { cmd: "x-terminal-emulator", args: ["-e", "ssh", ...sshArgs] },
        { cmd: "ghostty", args: ["ssh", ...sshArgs] },
        { cmd: "alacritty", args: ["-e", "ssh", ...sshArgs] },
        { cmd: "kitty", args: ["ssh", ...sshArgs] },
        { cmd: "wezterm", args: ["start", "--", "ssh", ...sshArgs] },
        { cmd: "gnome-terminal", args: ["--", "ssh", ...sshArgs] },
        { cmd: "konsole", args: ["-e", "ssh", ...sshArgs] },
        { cmd: "xfce4-terminal", args: ["-e", `ssh ${sshArgs.join(" ")}`] },
        { cmd: "xterm", args: ["-e", "ssh", ...sshArgs] },
      ];
    } else if (command) {
      // Run command in workspace directory
      const fullCommand = `cd "${workspacePath}" && ${command}`;
      terminals = [
        { cmd: "x-terminal-emulator", args: ["-e", "sh", "-c", fullCommand] },
        { cmd: "ghostty", args: ["-e", "sh", "-c", fullCommand] },
        { cmd: "alacritty", args: ["-e", "sh", "-c", fullCommand] },
        { cmd: "kitty", args: ["sh", "-c", fullCommand] },
        { cmd: "wezterm", args: ["start", "--", "sh", "-c", fullCommand] },
        { cmd: "gnome-terminal", args: ["--", "sh", "-c", fullCommand] },
        { cmd: "konsole", args: ["-e", "sh", "-c", fullCommand] },
        { cmd: "xfce4-terminal", args: ["-e", `sh -c '${fullCommand.replace(/'/g, "'\\''")}'`] },
        { cmd: "xterm", args: ["-e", "sh", "-c", fullCommand] },
      ];
    } else {
      // Just open terminal in directory
      terminals = [
        { cmd: "x-terminal-emulator", args: [], cwd: workspacePath },
        { cmd: "ghostty", args: ["--working-directory=" + workspacePath] },
        { cmd: "alacritty", args: ["--working-directory", workspacePath] },
        { cmd: "kitty", args: ["--directory", workspacePath] },
        { cmd: "wezterm", args: ["start", "--cwd", workspacePath] },
        { cmd: "gnome-terminal", args: ["--working-directory", workspacePath] },
        { cmd: "konsole", args: ["--workdir", workspacePath] },
        { cmd: "xfce4-terminal", args: ["--working-directory", workspacePath] },
        { cmd: "xterm", args: [], cwd: workspacePath },
      ];
    }

    const availableTerminal = await this.findAvailableTerminal(terminals);

    if (availableTerminal) {
      const cwdInfo = availableTerminal.cwd ? ` (cwd: ${availableTerminal.cwd})` : "";
      log.info(
        `Opening ${logPrefix}: ${availableTerminal.cmd} ${availableTerminal.args.join(" ")}${cwdInfo}`
      );
      const child = spawn(availableTerminal.cmd, availableTerminal.args, {
        cwd: availableTerminal.cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else {
      log.error("No terminal emulator found. Tried: " + terminals.map((t) => t.cmd).join(", "));
      throw new Error("No terminal emulator found");
    }
  }

  /**
   * Find the first available terminal emulator from a list
   */
  private async findAvailableTerminal(
    terminals: Array<{ cmd: string; args: string[]; cwd?: string }>
  ): Promise<{ cmd: string; args: string[]; cwd?: string } | null> {
    for (const terminal of terminals) {
      if (await isCommandAvailable(terminal.cmd)) {
        return terminal;
      }
    }
    return null;
  }

  onOutput(sessionId: string, callback: (data: string) => void): () => void {
    const emitter = this.outputEmitters.get(sessionId);
    if (!emitter) {
      // Session might not exist yet or closed.
      // If it doesn't exist, we can't subscribe.
      return () => {
        /* no-op */
      };
    }

    // Replay buffer
    const buffer = this.outputBuffers.get(sessionId);
    if (buffer) {
      buffer.forEach((data) => callback(data));
    }

    const handler = (data: string) => callback(data);
    emitter.on("data", handler);

    return () => {
      emitter.off("data", handler);
    };
  }

  onExit(sessionId: string, callback: (code: number) => void): () => void {
    const emitter = this.exitEmitters.get(sessionId);
    if (!emitter)
      return () => {
        /* no-op */
      };

    const handler = (code: number) => callback(code);
    emitter.on("exit", handler);

    return () => {
      emitter.off("exit", handler);
    };
  }

  private emitOutput(sessionId: string, data: string) {
    const emitter = this.outputEmitters.get(sessionId);
    if (emitter) {
      emitter.emit("data", data);
    }

    // Update buffer
    const buffer = this.outputBuffers.get(sessionId);
    if (buffer) {
      buffer.push(data);
      if (buffer.length > this.MAX_BUFFER_SIZE) {
        buffer.shift();
      }
    }
  }

  /**
   * Close all terminal sessions for a workspace.
   * Called when a workspace is removed to prevent resource leaks.
   */
  closeWorkspaceSessions(workspaceId: string): void {
    this.ptyService.closeWorkspaceSessions(workspaceId);
  }

  /**
   * Close all terminal sessions.
   * Called during server shutdown to prevent orphan PTY processes.
   */
  closeAllSessions(): void {
    this.ptyService.closeAllSessions();
  }

  private cleanup(sessionId: string) {
    this.outputEmitters.delete(sessionId);
    this.exitEmitters.delete(sessionId);
    this.outputBuffers.delete(sessionId);
  }
}
