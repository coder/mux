#!/usr/bin/env bun

/**
 * Run a command with a ready Storybook dev server.
 *
 * Why this exists: visual iteration is much faster when agents and humans can
 * reuse a warm Storybook process instead of repeatedly paying the cold-start
 * cost and hand-writing cleanup logic around ad-hoc Playwright scripts.
 */
import { spawn } from "child_process";

interface Options {
  port: number;
  timeoutMs: number;
  command: string[];
}

const DEFAULT_PORT = 6006;
const DEFAULT_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function printHelp(): void {
  console.log(`Usage:
  bun scripts/with-storybook.ts [--port <port>] [--timeout-ms <ms>] -- <command> [args...]

Starts Storybook only when it is not already ready on the requested port, then
runs the command with STORYBOOK_URL and STORYBOOK_PORT in its environment.

Examples:
  bun scripts/with-storybook.ts -- bun -e 'console.log(process.env.STORYBOOK_URL)'
  STORYBOOK_PORT=6010 bun scripts/with-storybook.ts --port 6010 -- bun scripts/my-check.ts
  make storybook-run CMD='bun -e "console.log(process.env.STORYBOOK_URL)"'
`);
}

function parsePositiveInteger(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function parsePort(value: string): number {
  const port = parsePositiveInteger(value, "--port");
  if (port > 65_535) {
    throw new Error(`--port must be <= 65535, got: ${value}`);
  }
  return port;
}

function parseArgs(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const delimiterIndex = argv.indexOf("--");
  if (delimiterIndex === -1) {
    throw new Error("Missing `-- <command>` delimiter. Run with --help for usage.");
  }

  const optionArgs = argv.slice(0, delimiterIndex);
  const command = argv.slice(delimiterIndex + 1);
  if (command.length === 0) {
    throw new Error("Missing command after `--`. Run with --help for usage.");
  }

  let port = parsePort(process.env.STORYBOOK_PORT ?? String(DEFAULT_PORT));
  let timeoutMs = parsePositiveInteger(
    process.env.STORYBOOK_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
    "--timeout-ms"
  );

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--port" || arg === "-p") {
      const value = optionArgs[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      port = parsePort(value);
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = optionArgs[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      timeoutMs = parsePositiveInteger(value, arg);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { port, timeoutMs, command };
}

function storybookUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function isStorybookReady(url: string): Promise<boolean> {
  try {
    // `/index.json` is Storybook-specific. Checking it prevents us from
    // accidentally reusing an unrelated process that merely occupies the port.
    const response = await fetch(`${url}/index.json`, { cache: "no-store" });
    if (!response.ok) return false;
    const indexJson = await response.json();
    return typeof indexJson === "object" && indexJson != null && "entries" in indexJson;
  } catch {
    return false;
  }
}

async function waitForStorybook(
  url: string,
  timeoutMs: number,
  serverProcess?: ReturnType<typeof spawnInherited>
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isStorybookReady(url)) {
      return;
    }
    if (serverProcess && (serverProcess.exitCode != null || serverProcess.signalCode != null)) {
      throw new Error(
        `Storybook exited before becoming ready (code=${serverProcess.exitCode ?? "null"}, signal=${
          serverProcess.signalCode ?? "null"
        })`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Storybook at ${url}`);
}

function spawnInherited(command: string[], env: NodeJS.ProcessEnv = process.env) {
  const [executable, ...args] = command;
  if (!executable) {
    throw new Error("Cannot spawn an empty command");
  }
  return spawn(executable, args, {
    env,
    stdio: "inherit",
    shell: false,
  });
}

async function waitForExit(child: ReturnType<typeof spawnInherited>): Promise<number> {
  if (typeof child.exitCode === "number") {
    return child.exitCode;
  }
  if (child.signalCode != null) {
    console.error(`Process exited from signal ${child.signalCode}`);
    return 1;
  }

  return await new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
      } else {
        console.error(`Process exited from signal ${signal ?? "unknown"}`);
        resolve(1);
      }
    });
  });
}

async function waitForExitWithTimeout(
  child: ReturnType<typeof spawnInherited>,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) {
    return true;
  }

  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateProcess(child: ReturnType<typeof spawnInherited>): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }

  child.kill("SIGTERM");
  if (await waitForExitWithTimeout(child, SHUTDOWN_TIMEOUT_MS)) {
    return;
  }

  console.error("Storybook did not exit after SIGTERM; sending SIGKILL");
  child.kill("SIGKILL");
  await waitForExitWithTimeout(child, SHUTDOWN_TIMEOUT_MS);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const url = storybookUrl(options.port);

  let startedStorybook: ReturnType<typeof spawnInherited> | null = null;
  let cleaningUp = false;

  const cleanup = async (): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (startedStorybook) {
      // Only kill the server we started. Reused Storybook instances belong to
      // the developer's session and should stay warm for the next visual check.
      await terminateProcess(startedStorybook);
    }
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    console.error(`Received ${signal}; cleaning up`);
    cleanup()
      .then(() => process.exit(signal === "SIGINT" ? 130 : 143))
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    if (await isStorybookReady(url)) {
      console.log(`Reusing Storybook at ${url}`);
    } else {
      console.log(`Starting Storybook at ${url}`);
      startedStorybook = spawnInherited([
        "bun",
        "x",
        "storybook",
        "dev",
        "-p",
        String(options.port),
        "--ci",
        "--quiet",
        "--no-open",
        "--no-version-updates",
        "--disable-telemetry",
        "--exact-port",
      ]);
      await waitForStorybook(url, options.timeoutMs, startedStorybook);
      console.log(`Storybook ready at ${url}`);
    }

    const commandEnv = {
      ...process.env,
      STORYBOOK_URL: url,
      STORYBOOK_PORT: String(options.port),
    };
    const commandProcess = spawnInherited(options.command, commandEnv);
    return await waitForExit(commandProcess);
  } finally {
    await cleanup();
  }
}

try {
  const exitCode = await main();
  process.exit(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
