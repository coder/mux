#!/usr/bin/env node
/**
 * Mux CLI entry point.
 *
 * LAZY LOADING REQUIREMENT:
 * We manually route subcommands before calling program.parse() to avoid
 * eagerly importing heavy modules. The desktop app imports Electron, which
 * fails when running CLI commands in non-GUI environments. Subcommands like
 * `run` and `server` import the AI SDK which has significant startup cost.
 *
 * By checking argv[2] first, we only load the code path actually needed.
 *
 * ELECTRON DETECTION:
 * When run via `electron .` or as a packaged app, Electron sets process.versions.electron.
 * In that case, we launch the desktop app automatically. When run via `bun` or `node`,
 * we show CLI help instead.
 */
import { Command } from "commander";
import { VERSION } from "../version";

const subcommand = process.argv[2];
const isElectron = "electron" in process.versions;

function launchDesktop(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../desktop/main");
}

// Route known subcommands to their dedicated entry points (each has its own Commander instance)
// When Electron launches us (e.g., `bunx electron --flags .`), argv[2] may be a flag or "." - not a subcommand
const isElectronLaunchArg = subcommand?.startsWith("-") || subcommand === ".";

if (subcommand === "run") {
  process.argv.splice(2, 1); // Remove "run" since run.ts defines .name("mux run")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./run");
} else if (subcommand === "server") {
  process.argv.splice(2, 1);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./server");
} else if (subcommand === "api") {
  process.argv.splice(2, 1);
  // Dynamic import required: trpc-cli is ESM-only and can't be require()'d
  // eslint-disable-next-line no-restricted-syntax
  void import("./api");
} else if (
  subcommand === "desktop" ||
  (isElectron && (subcommand === undefined || isElectronLaunchArg))
) {
  // Explicit `mux desktop`, or Electron runtime with no subcommand / Electron launch args
  launchDesktop();
} else {
  // No subcommand (non-Electron), flags (--help, --version), or unknown commands
  const program = new Command();
  program
    .name("mux")
    .description("Mux - AI agent orchestration")
    .version(`${VERSION.git_describe} (${VERSION.git_commit})`, "-v, --version");

  // Register subcommand stubs for help display (actual implementations are above)
  program.command("run").description("Run a one-off agent task");
  program.command("server").description("Start the HTTP/WebSocket ORPC server");
  program.command("api").description("Interact with the mux API via a running server");
  program.command("desktop").description("Launch the desktop app (requires Electron)");

  program.parse();
}
