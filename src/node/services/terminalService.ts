import { EventEmitter } from "events";
import type { Config } from "@/node/config";
import type { PTYService } from "@/node/services/ptyService";
import type {
  TerminalSession,
  TerminalCreateParams,
  TerminalResizeParams,
} from "@/common/types/terminal";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { log } from "@/node/services/log";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

export class TerminalService {
  private readonly config: Config;
  private readonly ptyService: PTYService;

  // Event emitters for each session
  private readonly outputEmitters = new Map<string, EventEmitter>();
  private readonly exitEmitters = new Map<string, EventEmitter>();

  // Headless terminals for maintaining parsed terminal state on the backend.
  // On reconnect, we serialize the screen state (~4KB) instead of replaying raw output (~512KB).
  private readonly headlessTerminals = new Map<string, Terminal>();
  private readonly serializeAddons = new Map<string, SerializeAddon>();
  private readonly headlessOnDataDisposables = new Map<string, { dispose: () => void }>();

  constructor(config: Config, ptyService: PTYService) {
    this.config = config;
    this.ptyService = ptyService;
  }

  async create(params: TerminalCreateParams): Promise<TerminalSession> {
    try {
      // 1. Resolve workspace
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspaceMetadata = allMetadata.find((w) => w.id === params.workspaceId);

      if (!workspaceMetadata) {
        throw new Error(`Workspace not found: ${params.workspaceId}`);
      }

      // Validate required fields before proceeding - projectPath is required for project-dir runtimes
      if (!workspaceMetadata.projectPath) {
        log.error("Workspace metadata missing projectPath", {
          workspaceId: params.workspaceId,
          name: workspaceMetadata.name,
          runtimeConfig: workspaceMetadata.runtimeConfig,
          projectName: workspaceMetadata.projectName,
          metadata: JSON.stringify(workspaceMetadata),
        });
        throw new Error(
          `Workspace "${workspaceMetadata.name}" (${params.workspaceId}) is missing projectPath. ` +
            `This may indicate a corrupted config or a workspace that was not properly associated with a project.`
        );
      }

      // 2. Create runtime (pass workspace info for Docker container name derivation)
      const runtime = createRuntime(
        workspaceMetadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir },
        { projectPath: workspaceMetadata.projectPath, workspaceName: workspaceMetadata.name }
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

      // Initialize emitters and headless terminal for state tracking
      this.outputEmitters.set(session.sessionId, new EventEmitter());
      this.exitEmitters.set(session.sessionId, new EventEmitter());

      // Create headless terminal to maintain parsed state for reconnection
      // allowProposedApi is required for SerializeAddon to access the buffer
      const headless = new Terminal({
        cols: params.cols,
        rows: params.rows,
        allowProposedApi: true,
      });

      // Respond to terminal device queries (DA1/DSR) on the backend.
      //
      // Some TUIs (e.g. Yazi) issue terminal probes like `\x1b[0c` during startup and expect
      // the terminal emulator to reply quickly. When the renderer isn't mounted yet (or IPC
      // is slow), relying on the frontend alone can lead to timeouts.
      const disposeHeadlessOnData = headless.onData((data: string) => {
        if (!data) {
          return;
        }

        try {
          this.ptyService.sendInput(session.sessionId, data);
        } catch (error) {
          log.debug("[TerminalService] Failed to forward terminal response", {
            sessionId: session.sessionId,
            error,
          });
        }
      });
      const serializeAddon = new SerializeAddon();
      headless.loadAddon(serializeAddon);
      this.headlessOnDataDisposables.set(session.sessionId, disposeHeadlessOnData);
      this.headlessTerminals.set(session.sessionId, headless);
      this.serializeAddons.set(session.sessionId, serializeAddon);

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

      // Also resize the headless terminal to keep state in sync
      const headless = this.headlessTerminals.get(params.sessionId);
      headless?.resize(params.cols, params.rows);
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

  onOutput(sessionId: string, callback: (data: string) => void): () => void {
    const emitter = this.outputEmitters.get(sessionId);
    if (!emitter) {
      // Session might not exist yet or closed.
      // If it doesn't exist, we can't subscribe.
      return () => {
        /* no-op */
      };
    }

    // Note: The attach stream yields screenState first, then live output.
    // This subscription only provides live output from the point of subscription onward.

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

  /**
   * Get serialized screen state for a session.
   * Called by frontend on reconnect to restore terminal view instantly (~4KB vs 512KB raw replay).
   * Returns VT escape sequences that reconstruct the current screen state.
   *
   * Note: @xterm/addon-serialize v0.14+ automatically includes the alternate buffer switch
   * sequence (\x1b[?1049h) when the terminal is in alternate screen mode (htop, vim, etc.).
   */
  getScreenState(sessionId: string): string {
    const addon = this.serializeAddons.get(sessionId);
    return addon?.serialize() ?? "";
  }

  private emitOutput(sessionId: string, data: string) {
    // Write to headless terminal to maintain parsed state (and generate device-query responses)
    const headless = this.headlessTerminals.get(sessionId);
    headless?.write(data);

    const emitter = this.outputEmitters.get(sessionId);
    if (emitter) {
      emitter.emit("data", data);
    }
  }

  /**
   * Get all session IDs for a workspace.
   * Used by frontend to discover existing sessions to reattach to after reload.
   */
  getWorkspaceSessionIds(workspaceId: string): string[] {
    return this.ptyService.getWorkspaceSessionIds(workspaceId);
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
    const disposeHeadlessOnData = this.headlessOnDataDisposables.get(sessionId);
    disposeHeadlessOnData?.dispose();
    this.headlessOnDataDisposables.delete(sessionId);
    this.outputEmitters.delete(sessionId);
    this.exitEmitters.delete(sessionId);

    // Dispose and clean up headless terminal
    const headless = this.headlessTerminals.get(sessionId);
    headless?.dispose();
    this.headlessTerminals.delete(sessionId);
    this.serializeAddons.delete(sessionId);
  }
}
