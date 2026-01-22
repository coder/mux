#!/usr/bin/env bun
/**
 * Start an isolated `make dev-server` instance.
 *
 * Why:
 * - `make dev-server` starts the mux backend server which uses a lockfile at:
 *     <muxHome>/server.lock
 *   (default muxHome is ~/.mux-dev in development)
 * - This prevents running multiple dev servers concurrently.
 *
 * This script creates a fresh temporary mux root dir, copies over the user's
 * provider config + project list, picks free ports, then launches `make dev-server`.
 *
 * Usage:
 *   make dev-server-sandbox
 *
 * Optional env vars:
 *   - SEED_MUX_ROOT=/path/to/mux/home   # where to copy providers.jsonc/config.json from
 *   - KEEP_SANDBOX=1                   # don't delete temp MUX_ROOT on exit
 *   - BACKEND_PORT=3001                # override picked backend port
 *   - VITE_PORT=5174                   # override picked Vite port
 *   - MAKE=gmake                       # override make binary
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  chooseSeedMuxRoot,
  copyFileIfExists,
  forwardSignalsToChildProcesses,
  getFreePort,
  parseOptionalPort,
} from "./sandboxUtils";

async function main(): Promise<number> {
  const keepSandbox = process.env.KEEP_SANDBOX === "1";
  const makeCmd = process.env.MAKE ?? "make";

  // Do any validation that might throw *before* creating the temp root so we
  // don't leave behind stale `mux-dev-server-*` directories for simple mistakes.
  const seedMuxRoot = chooseSeedMuxRoot();

  const backendPortOverride = parseOptionalPort(process.env.BACKEND_PORT);
  const vitePortOverride = parseOptionalPort(process.env.VITE_PORT);

  if (
    backendPortOverride !== null &&
    vitePortOverride !== null &&
    backendPortOverride === vitePortOverride
  ) {
    throw new Error("BACKEND_PORT and VITE_PORT must be different");
  }

  let backendPort: number;
  if (backendPortOverride !== null) {
    backendPort = backendPortOverride;
  } else {
    backendPort = await getFreePort();

    // If the user explicitly chose a Vite port, keep it stable and move the
    // backend port instead.
    while (vitePortOverride !== null && backendPort === vitePortOverride) {
      backendPort = await getFreePort();
    }
  }

  let vitePort: number;
  if (vitePortOverride !== null) {
    vitePort = vitePortOverride;
  } else {
    vitePort = await getFreePort();
    while (vitePort === backendPort) {
      vitePort = await getFreePort();
    }
  }

  const muxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mux-dev-server-"));

  try {
    const seedProvidersPath = seedMuxRoot ? path.join(seedMuxRoot, "providers.jsonc") : null;
    const seedConfigPath = seedMuxRoot ? path.join(seedMuxRoot, "config.json") : null;

    const copiedProviders = seedProvidersPath
      ? copyFileIfExists(seedProvidersPath, path.join(muxRoot, "providers.jsonc"), { mode: 0o600 })
      : false;
    const copiedConfig = seedConfigPath
      ? copyFileIfExists(seedConfigPath, path.join(muxRoot, "config.json"))
      : false;

    console.log("\nStarting mux dev-server sandbox...");
    console.log(`  MUX_ROOT:        ${muxRoot}`);
    if (seedMuxRoot) {
      console.log(`  Seeded from:     ${seedMuxRoot}`);
      console.log(`  Copied config:   ${copiedConfig ? "yes" : "no"}`);
      console.log(`  Copied providers: ${copiedProviders ? "yes" : "no"}`);
    } else {
      console.log("  Seeded from:     (none)");
    }
    console.log(`  Backend:         http://127.0.0.1:${backendPort}`);
    console.log(`  Frontend:        http://localhost:${vitePort}`);
    if (keepSandbox) {
      console.log("  KEEP_SANDBOX=1 (temp root will not be deleted)");
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(makeCmd, ["dev-server"], {
        stdio: "inherit",
        env: {
          ...process.env,

          // Allow access via reverse proxies / port-forwarding domains.
          // This sets the Makefile's `VITE_ALLOWED_HOSTS`, which is forwarded to
          // `MUX_VITE_ALLOWED_HOSTS` and then consumed by `vite.config.ts`.
          VITE_ALLOWED_HOSTS: process.env.VITE_ALLOWED_HOSTS ?? "all",

          MUX_ROOT: muxRoot,
          BACKEND_PORT: String(backendPort),
          VITE_PORT: String(vitePort),
        },
      });
    } catch (err) {
      console.error(`Failed to start ${makeCmd} dev-server:`, err);
      throw err;
    }

    // Forward signals so Ctrl+C stops all subprocesses.
    forwardSignalsToChildProcesses(() => [child]);

    const exitCode = await new Promise<number>((resolve) => {
      let resolved = false;
      const finish = (code: number): void => {
        if (resolved) return;
        resolved = true;
        resolve(code);
      };

      // If spawning fails (e.g. ENOENT for `make`), Node emits `error` but does
      // not emit `exit`. Without this, we'd hang.
      child.on("error", (err) => {
        console.error(`Failed to start ${makeCmd} dev-server:`, err);
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

    return exitCode;
  } finally {
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
