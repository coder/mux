/**
 * CLI environment detection for correct argv parsing across:
 * - bun/node direct invocation
 * - Electron dev mode (electron .)
 * - Packaged Electron app (./mux.AppImage)
 */

export interface CliEnvironment {
  /** Running under Electron runtime */
  isElectron: boolean;
  /** Running as packaged Electron app (not dev mode) */
  isPackagedElectron: boolean;
  /** Index of first user argument in process.argv */
  firstArgIndex: number;
}

/**
 * Detect CLI environment from process state.
 *
 * | Environment       | isElectron | defaultApp | firstArgIndex |
 * |-------------------|------------|------------|---------------|
 * | bun/node          | false      | undefined  | 2             |
 * | electron dev      | true       | true       | 2             |
 * | packaged electron | true       | undefined  | 1             |
 */
export function detectCliEnvironment(
  versions: Record<string, string | undefined> = process.versions,
  defaultApp: boolean | undefined = process.defaultApp
): CliEnvironment {
  const isElectron = "electron" in versions;
  const isPackagedElectron = isElectron && !defaultApp;
  const firstArgIndex = isPackagedElectron ? 1 : 2;
  return { isElectron, isPackagedElectron, firstArgIndex };
}

/**
 * Get Commander parse options for current environment.
 * Use with: program.parse(process.argv, getParseOptions())
 */
export function getParseOptions(env: CliEnvironment = detectCliEnvironment()): {
  from: "electron" | "node";
} {
  return { from: env.isPackagedElectron ? "electron" : "node" };
}

/**
 * Get the subcommand from argv (e.g., "server", "api", "run").
 */
export function getSubcommand(
  argv: string[] = process.argv,
  env: CliEnvironment = detectCliEnvironment()
): string | undefined {
  return argv[env.firstArgIndex];
}

/**
 * Get args for a subcommand after the subcommand name has been spliced out.
 * This is what subcommand handlers (server.ts, api.ts, run.ts) use after
 * index.ts removes the subcommand name from process.argv.
 *
 * @example
 * // Original: ["electron", ".", "api", "--help"]
 * // After index.ts splices: ["electron", ".", "--help"]
 * // getArgsAfterSplice returns: ["--help"]
 */
export function getArgsAfterSplice(
  argv: string[] = process.argv,
  env: CliEnvironment = detectCliEnvironment()
): string[] {
  return argv.slice(env.firstArgIndex);
}

/**
 * Check if the subcommand is an Electron launch arg (not a real CLI command).
 * In dev mode (electron --inspect .), argv may contain flags or "." before the subcommand.
 * These should trigger desktop launch, not CLI processing.
 */
export function isElectronLaunchArg(
  subcommand: string | undefined,
  env: CliEnvironment = detectCliEnvironment()
): boolean {
  if (env.isPackagedElectron || !env.isElectron) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: false from startsWith should still check "."
  return subcommand?.startsWith("-") || subcommand === ".";
}

/**
 * Check if a command is available in the current environment.
 * The "run" command requires bun/node - it's not bundled in Electron.
 */
export function isCommandAvailable(
  command: string,
  env: CliEnvironment = detectCliEnvironment()
): boolean {
  if (command === "run") {
    // run.ts is only available in bun/node, not bundled in Electron (dev or packaged)
    return !env.isElectron;
  }
  return true;
}
