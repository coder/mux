#!/usr/bin/env bun
/**
 * Start an isolated Electron dev instance (Vite + Electron main process).
 *
 * Why:
 * - Electron uses the mux home directory (MUX_ROOT / ~/.mux-dev) for config,
 *   sessions, worktrees, etc.
 * - Running multiple Electron instances against the same mux root is noisy and
 *   risky during development.
 *
 * This script creates a fresh temporary mux root dir, optionally copies over the
 * user's providers/config, picks free ports, then launches:
 *   - `make dev`   (Vite + watchers)
 *   - `bunx electron ... .` (desktop app)
 *
 * Usage:
 *   make dev-desktop-sandbox
 *
 * Optional env vars:
 *   - SEED_MUX_ROOT=/path/to/mux/home   # where to copy providers.jsonc/config.json from
 *   - KEEP_SANDBOX=1                   # don't delete temp MUX_ROOT on exit
 *   - VITE_PORT=5174                   # override picked Vite port
 *   - VITE_READY_TIMEOUT_MS=60000      # override Vite readiness timeout
 *   - ELECTRON_DEBUG_PORT=9223         # override picked Electron remote debugging port
 *   - ELECTRON_DEBUG_PORT=0            # disable Electron remote debugging port entirely
 *   - MAKE=gmake                       # override make binary
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  chooseSeedMuxRoot,
  copyFileIfExists,
  forwardSignalsToChildProcesses,
  getFreePort,
  parseOptionalPort,
  waitForHttpReady,
} from "./sandboxUtils";

function parseElectronDebugPort(
  raw: string | undefined
): { mode: "disabled" } | { mode: "enabled"; portOverride: number | null } {
  if (raw === "0") {
    return { mode: "disabled" };
  }

  return { mode: "enabled", portOverride: parseOptionalPort(raw) };
}

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  // IPv6 URLs must be bracketed: http://[::1]:1234
  if (unbracketed.includes(":")) {
    // If the host contains a zone index (e.g. fe80::1%en0), percent must be encoded.
    // Encode zone indices (including numeric ones like %12) while avoiding double-encoding
    // if the user already provided a URL-safe %25.
    const escaped = unbracketed.replace(/%(?!25)/gi, "%25");
    return `[${escaped}]`;
  }

  return unbracketed;
}

async function waitForChildExit(child: ReturnType<typeof spawn>, name: string): Promise<number> {
  if (!name) {
    throw new Error("Expected process name");
  }

  return await new Promise<number>((resolve) => {
    let resolved = false;
    const finish = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };

    child.on("error", (err) => {
      console.error(`Failed to start ${name}:`, err);
      finish(1);
    });

    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        finish(code);
      } else {
        // When killed by signal, prefer a non-zero exit code.
        finish(signal ? 1 : 0);
      }
    });
  });
}

async function main(): Promise<number> {
  const keepSandbox = process.env.KEEP_SANDBOX === "1";
  const makeCmd = process.env.MAKE ?? "make";

  // Do any validation that might throw *before* creating the temp root so we
  // don't leave behind stale `mux-desktop-*` directories for simple mistakes.
  const seedMuxRoot = chooseSeedMuxRoot();

  const vitePortOverride = parseOptionalPort(process.env.VITE_PORT);
  const debugPortConfig = parseElectronDebugPort(process.env.ELECTRON_DEBUG_PORT);

  let vitePort: number;
  if (vitePortOverride !== null) {
    vitePort = vitePortOverride;
  } else {
    vitePort = await getFreePort();
  }

  let electronDebugPort: number | null;
  if (debugPortConfig.mode === "disabled") {
    electronDebugPort = null;
  } else if (debugPortConfig.portOverride !== null) {
    electronDebugPort = debugPortConfig.portOverride;
  } else {
    electronDebugPort = await getFreePort();
  }

  if (electronDebugPort !== null) {
    while (electronDebugPort === vitePort) {
      electronDebugPort = await getFreePort();
    }
  }

  const muxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mux-desktop-"));

  let devProc: ReturnType<typeof spawn> | null = null;
  let electronProc: ReturnType<typeof spawn> | null = null;

  try {
    const seedProvidersPath = seedMuxRoot ? path.join(seedMuxRoot, "providers.jsonc") : null;
    const seedConfigPath = seedMuxRoot ? path.join(seedMuxRoot, "config.json") : null;

    const copiedProviders = seedProvidersPath
      ? copyFileIfExists(seedProvidersPath, path.join(muxRoot, "providers.jsonc"), { mode: 0o600 })
      : false;
    const copiedConfig = seedConfigPath
      ? copyFileIfExists(seedConfigPath, path.join(muxRoot, "config.json"))
      : false;

    console.log("\nStarting mux desktop sandbox...");
    console.log(`  MUX_ROOT:        ${muxRoot}`);
    if (seedMuxRoot) {
      console.log(`  Seeded from:     ${seedMuxRoot}`);
      console.log(`  Copied config:   ${copiedConfig ? "yes" : "no"}`);
      console.log(`  Copied providers: ${copiedProviders ? "yes" : "no"}`);
    } else {
      console.log("  Seeded from:     (none)");
    }
    console.log(`  Vite:            http://127.0.0.1:${vitePort}`);
    if (electronDebugPort !== null) {
      console.log(`  Electron debug:  http://127.0.0.1:${electronDebugPort}`);
    } else {
      console.log("  Electron debug:  (disabled)");
    }
    if (keepSandbox) {
      console.log("  KEEP_SANDBOX=1 (temp root will not be deleted)");
    }

    devProc = spawn(makeCmd, ["dev"], {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "development",
        MUX_ROOT: muxRoot,
        MUX_VITE_PORT: String(vitePort),
      },
    });

    const devExitPromise = waitForChildExit(devProc, `${makeCmd} dev`);

    // Forward signals so Ctrl+C stops all subprocesses.
    forwardSignalsToChildProcesses(() => [devProc, electronProc]);

    // Wait for Vite to be ready before starting Electron.
    const viteReadyTimeoutMs = (() => {
      const raw = process.env.VITE_READY_TIMEOUT_MS;
      if (!raw) return 60_000;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return 60_000;
      return parsed;
    })();

    const viteReadyUrls = [
      `http://${formatHostForUrl("127.0.0.1")}:${vitePort}`,
      `http://${formatHostForUrl("localhost")}:${vitePort}`,
    ];

    const readyOrExit = await Promise.race([
      waitForHttpReady(viteReadyUrls, viteReadyTimeoutMs).then(() => ({ type: "ready" as const })),
      devExitPromise.then((code) => ({ type: "exit" as const, code })),
    ]);

    if (readyOrExit.type === "exit") {
      console.error(`Vite dev server exited early (code ${readyOrExit.code})`);
      return readyOrExit.code;
    }

    // Electron expects dist/splash.html to exist (make start depends on build-static).
    const staticResult = spawnSync(makeCmd, ["build-static"], {
      stdio: "inherit",
      env: {
        ...process.env,
      },
    });

    if (staticResult.status !== 0) {
      console.error(
        `Failed to run ${makeCmd} build-static (exit ${staticResult.status ?? "unknown"})`
      );
      return staticResult.status ?? 1;
    }

    const electronArgs = ["electron"];
    if (electronDebugPort !== null) {
      electronArgs.push(`--remote-debugging-port=${electronDebugPort}`);
    }
    electronArgs.push(".");

    electronProc = spawn("bunx", electronArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "development",
        MUX_ROOT: muxRoot,
        MUX_DEVSERVER_HOST: "127.0.0.1",
        MUX_DEVSERVER_PORT: String(vitePort),

        // If the user's config.json specifies apiServerPort, we can easily hit EADDRINUSE
        // while running multiple sandboxes. Default to port 0 (random) unless overridden.
        MUX_SERVER_PORT: process.env.MUX_SERVER_PORT ?? "0",

        // Allow multiple dev Electron instances concurrently.
        CMUX_ALLOW_MULTIPLE_INSTANCES: "1",
      },
    });

    const electronExitPromise = waitForChildExit(electronProc, "bunx electron");

    const firstExit = await Promise.race([
      devExitPromise.then((code) => ({ which: "dev" as const, code })),
      electronExitPromise.then((code) => ({ which: "electron" as const, code })),
    ]);

    if (firstExit.which === "dev") {
      // Vite/watchers exited - stop Electron too.
      if (electronProc.exitCode === null && !electronProc.killed) {
        electronProc.kill("SIGTERM");
      }

      // Ensure the Electron process is torn down before returning.
      await electronExitPromise;
      return firstExit.code;
    }

    // Electron exited - stop Vite/watchers.
    if (devProc.exitCode === null && !devProc.killed) {
      devProc.kill("SIGTERM");
    }

    await devExitPromise;
    return firstExit.code;
  } finally {
    // Best-effort cleanup.
    if (electronProc && electronProc.exitCode === null && !electronProc.killed) {
      electronProc.kill("SIGTERM");
    }
    if (devProc && devProc.exitCode === null && !devProc.killed) {
      devProc.kill("SIGTERM");
    }

    if (!keepSandbox) {
      try {
        fs.rmSync(muxRoot, { recursive: true, force: true });
      } catch (err) {
        console.error(`Failed to remove sandbox MUX_ROOT at ${muxRoot}:`, err);
      }
    }
  }
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
