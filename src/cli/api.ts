/**
 * API CLI subcommand - delegates to a running mux server via HTTP.
 *
 * This module is loaded lazily to avoid pulling in ESM-only dependencies
 * (trpc-cli) when running other commands like the desktop app.
 *
 * Server discovery priority:
 * 1. MUX_SERVER_URL env var (explicit override)
 * 2. Lockfile at ~/.mux/server.lock (running Electron or mux server)
 * 3. Fallback to http://localhost:3000
 */

import { createCli } from "trpc-cli";
import { router } from "@/node/orpc/router";
import { proxifyOrpc } from "./proxifyOrpc";
import { ServerLockfile } from "@/node/services/serverLockfile";
import { getMuxHome } from "@/common/constants/paths";
import type { Command } from "commander";

interface ServerDiscovery {
  baseUrl: string;
  authToken: string | undefined;
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

// Run async discovery then start CLI
(async () => {
  const { baseUrl, authToken } = await discoverServer();

  const proxiedRouter = proxifyOrpc(router(), { baseUrl, authToken });
  const cli = createCli({ router: proxiedRouter }).buildProgram() as Command;

  cli.name("mux api");
  cli.description("Interact with the mux API via a running server");
  cli.parse();
})();
