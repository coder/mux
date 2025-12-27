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
import { getArgsAfterSplice } from "./argv";
import { discoverServer } from "./discoverServer";

// index.ts already splices "api" from argv before importing this module,
// so we just need to get the remaining args after the splice point.
const args = getArgsAfterSplice();

// Run async discovery then start CLI
(async () => {
  const { baseUrl, authToken } = await discoverServer({ fallbackBaseUrl: "http://localhost:3000" });

  const proxiedRouter = proxifyOrpc(router(), { baseUrl, authToken });

  // Use trpc-cli's run() method instead of buildProgram().parse()
  // run() sets exitOverride on root, uses parseAsync, and handles process exit properly
  const { run } = createCli({
    router: proxiedRouter,
    name: "mux api",
    description: "Interact with the mux API via a running server",
  });

  try {
    await run({ argv: args });
  } catch (error) {
    // trpc-cli throws FailedToExitError after calling process.exit()
    // In Electron, process.exit() doesn't immediately terminate, so the error surfaces.
    // This is expected and safe to ignore since exit was already requested.
    if (error instanceof Error && error.constructor.name === "FailedToExitError") {
      return;
    }
    throw error;
  }
})();
