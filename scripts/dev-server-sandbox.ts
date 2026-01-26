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
 * Optional CLI flags:
 *   - --clean-providers
 *   - --clean-projects
 *   - --help
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
  copyConfigClearingProjectsIfExists,
  copyFileIfExists,
  forwardSignalsToChildProcesses,
  getFreePort,
  parseOptionalPort,
} from "./sandboxUtils";

type SandboxCliFlags = {
  cleanProviders: boolean;
  cleanProjects: boolean;
  help: boolean;
};

function parseSandboxCliFlags(argv: string[]): SandboxCliFlags {
  const args = new Set(argv);
  const knownArgs = new Set(["--clean-providers", "--clean-projects", "--help"]);

  for (const arg of args) {
    if (!knownArgs.has(arg)) {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  return {
    cleanProviders: args.has("--clean-providers"),
    cleanProjects: args.has("--clean-projects"),
    help: args.has("--help"),
  };
}

function printHelp(): void {
  console.log(`Usage:
  make dev-server-sandbox

Optional CLI flags:
  --clean-providers   Do not copy providers.jsonc into the sandbox
  --clean-projects    Do not import projects from config.json (projects will be empty)

Note: to pass flags via make, use:
  make dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers --clean-projects"`);
}

async function main(): Promise<number> {
  const cliFlags = parseSandboxCliFlags(process.argv.slice(2));
  if (cliFlags.help) {
    printHelp();
    return 0;
  }

  const cleanProviders = cliFlags.cleanProviders;
  const cleanProjects = cliFlags.cleanProjects;

  const keepSandbox = process.env.KEEP_SANDBOX === "1";
  const makeCmd = process.env.MAKE ?? "make";

  // Do any validation that might throw *before* creating the temp root so we
  // don't leave behind stale `mux-dev-server-*` directories for simple mistakes.
  const shouldSeed = !(cleanProviders && cleanProjects);
  const seedMuxRoot = shouldSeed ? chooseSeedMuxRoot() : null;

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
    const seedProvidersPath =
      seedMuxRoot && !cleanProviders ? path.join(seedMuxRoot, "providers.jsonc") : null;
    const seedConfigPath = seedMuxRoot ? path.join(seedMuxRoot, "config.json") : null;

    const sandboxProvidersPath = path.join(muxRoot, "providers.jsonc");
    const sandboxConfigPath = path.join(muxRoot, "config.json");

    const copiedProviders = seedProvidersPath
      ? copyFileIfExists(seedProvidersPath, sandboxProvidersPath, { mode: 0o600 })
      : false;
    const copiedConfig = seedConfigPath
      ? cleanProjects
        ? copyConfigClearingProjectsIfExists(seedConfigPath, sandboxConfigPath)
        : copyFileIfExists(seedConfigPath, sandboxConfigPath)
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
    if (cleanProviders || cleanProjects) {
      console.log(`  Clean providers: ${cleanProviders ? "yes" : "no"}`);
      console.log(`  Clean projects:  ${cleanProjects ? "yes" : "no"}`);
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
