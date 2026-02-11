import { Command } from "commander";
import { render } from "ink";
import WebSocket from "ws";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import { createClient } from "@/common/orpc/client";
import { ServerLockfile } from "@/node/services/serverLockfile";
import { getMuxHome } from "@/common/constants/paths";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import { getArgsAfterSplice } from "./argv";
import { TuiApp } from "./tui/TuiApp";
import type { TuiOptions } from "./tui/tuiTypes";

interface ParsedTuiFlags extends TuiOptions {
  serverUrl?: string;
  authToken?: string;
}

interface ServerDiscovery {
  baseUrl: string;
  authToken: string | undefined;
}

function parseTuiFlags(): ParsedTuiFlags {
  const program = new Command();

  program
    .name("mux tui")
    .description("Launch simplified terminal UI")
    .option("--server-url <url>", "Server base URL for oRPC (e.g. http://localhost:3000)")
    .option("--auth-token <token>", "Auth token for server connection")
    .option("--model <model>", "Default model for chat sessions", DEFAULT_MODEL)
    .option("--agent-id <agentId>", "Agent ID to use for chat sessions", "exec");

  program.parse(getArgsAfterSplice(), { from: "user" });

  return program.opts<ParsedTuiFlags>();
}

async function discoverServer(): Promise<ServerDiscovery> {
  // Priority 1: Explicit env vars override everything
  if (process.env.MUX_SERVER_URL) {
    return {
      baseUrl: process.env.MUX_SERVER_URL,
      authToken: process.env.MUX_SERVER_AUTH_TOKEN,
    };
  }

  // Priority 2: Try lockfile discovery (running Electron or mux server)
  try {
    const lockfile = new ServerLockfile(getMuxHome());
    const data = await lockfile.read();
    if (data) {
      return {
        baseUrl: data.baseUrl,
        authToken: data.token,
      };
    }
  } catch {
    // Ignore lockfile errors
  }

  // Priority 3: Default fallback (standalone server on default port)
  return {
    baseUrl: "http://localhost:3000",
    authToken: process.env.MUX_SERVER_AUTH_TOKEN,
  };
}

function assertTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("mux tui requires an interactive TTY for both stdin and stdout.");
  }
}

async function runTui(): Promise<void> {
  const flags = parseTuiFlags();
  assertTty();

  const discovered = await discoverServer();
  const baseUrl = flags.serverUrl ?? discovered.baseUrl;
  const authToken = flags.authToken ?? discovered.authToken;

  const wsUrl = new URL(`${baseUrl}/orpc/ws`);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  if (authToken) {
    wsUrl.searchParams.set("token", authToken);
  }

  const ws = new WebSocket(wsUrl.toString());
  const closeSocket = () => {
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };

  let isAlternateScreenActive = false;
  const restoreTerminal = () => {
    if (!isAlternateScreenActive) {
      return;
    }

    process.stdout.write("\x1b[?25h");
    process.stdout.write("\x1b[?1049l");
    isAlternateScreenActive = false;
  };

  const cleanupOnExit = () => {
    restoreTerminal();
    closeSocket();
  };

  process.once("exit", cleanupOnExit);

  try {
    const link = new WebSocketLink({ websocket: ws as unknown as globalThis.WebSocket });
    const api = createClient(link);

    // Validate auth/token before initializing the UI.
    await api.general.ping("tui-auth-check");

    // Enter alternate screen buffer to prevent flashing during Ink re-renders.
    // This is how full-screen terminal apps (vim, htop, etc.) avoid visible redraws.
    process.stdout.write("\x1b[?1049h");
    process.stdout.write("\x1b[?25l");
    isAlternateScreenActive = true;

    const { waitUntilExit } = render(<TuiApp api={api} options={flags} />, { exitOnCtrlC: false });
    await waitUntilExit();
  } finally {
    cleanupOnExit();
    process.off("exit", cleanupOnExit);
  }
}

void runTui().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to launch mux tui: ${message}`);
  process.exit(1);
});
