import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { prepareDemoProject, type DemoProjectConfig } from "./utils/demoProject";
import { createWorkspaceUI, type WorkspaceUI } from "./utils/ui";

interface WorkspaceHarness {
  configRoot: string;
  demoProject: DemoProjectConfig;
}

interface ElectronFixtures {
  app: ElectronApplication;
  page: Page;
  workspace: WorkspaceHarness;
  ui: WorkspaceUI;
}

const appRoot = path.resolve(__dirname, "..", "..");
const defaultTestRoot = path.join(appRoot, "tests", "e2e", "tmp", "mux-root");
const BASE_DEV_SERVER_PORT = Number(process.env.MUX_E2E_DEVSERVER_PORT_BASE ?? "5173");
const shouldLoadDist = process.env.MUX_E2E_LOAD_DIST === "1";

const REQUIRED_DIST_FILES = [
  path.join(appRoot, "dist", "index.html"),
  path.join(appRoot, "dist", "cli", "index.js"),
  path.join(appRoot, "dist", "desktop", "main.js"),
  path.join(appRoot, "dist", "preload.js"),
] as const;

function assertDistBundleReady(): void {
  if (!shouldLoadDist) {
    return;
  }
  for (const filePath of REQUIRED_DIST_FILES) {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Missing build artifact at ${filePath}. Run "make build" before executing dist-mode e2e tests.`
      );
    }
  }
}

async function waitForServerReady(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok || response.status === 404) {
        return;
      }
    } catch (error) {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for dev server at ${url}`);
}

function sanitizeForPath(value: string): string {
  const compact = value
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "")
    .toLowerCase();
  return compact.length > 0 ? compact : `test-${Date.now()}`;
}

function shouldSkipBuild(): boolean {
  return process.env.MUX_E2E_SKIP_BUILD === "1";
}

function buildTarget(target: string): void {
  if (shouldSkipBuild()) {
    return;
  }
  const result = spawnSync("make", [target], {
    cwd: appRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build ${target} (exit ${result.status ?? "unknown"})`);
  }
}

export const electronTest = base.extend<ElectronFixtures>({
  workspace: async ({}, use, testInfo) => {
    const envRoot = process.env.MUX_ROOT ?? "";
    const baseRoot = envRoot || defaultTestRoot;
    const uniqueTestId = testInfo.testId || testInfo.title || `test-${Date.now()}`;
    const testRoot = envRoot ? baseRoot : path.join(baseRoot, sanitizeForPath(uniqueTestId));

    const shouldCleanup = !envRoot;

    await fsPromises.mkdir(path.dirname(testRoot), { recursive: true });
    await fsPromises.rm(testRoot, { recursive: true, force: true });
    await fsPromises.mkdir(testRoot, { recursive: true });

    const demoProject = prepareDemoProject(testRoot);
    const userDataDir = path.join(testRoot, "user-data");
    await fsPromises.rm(userDataDir, { recursive: true, force: true });

    await use({
      configRoot: testRoot,
      demoProject,
    });

    if (shouldCleanup) {
      await fsPromises.rm(testRoot, { recursive: true, force: true });
    }
  },
  app: async ({ workspace }, use, testInfo) => {
    const { configRoot } = workspace;
    const devServerPort = BASE_DEV_SERVER_PORT + testInfo.workerIndex;

    if (shouldLoadDist) {
      assertDistBundleReady();
    } else {
      buildTarget("build-main");
      buildTarget("build-preload");
    }

    const shouldStartDevServer = !shouldLoadDist;
    let devServer: ReturnType<typeof spawn> | undefined;
    let devServerExited = false;
    let devServerExitPromise: Promise<void> | undefined;

    if (shouldStartDevServer) {
      devServer = spawn("make", ["dev"], {
        cwd: appRoot,
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...process.env,
          NODE_ENV: "development",
          VITE_DISABLE_MERMAID: "1",
          MUX_VITE_PORT: String(devServerPort),
        },
      });

      const activeDevServer = devServer;
      if (!activeDevServer) {
        throw new Error("Failed to spawn dev server process");
      }

      devServerExitPromise = new Promise<void>((resolve) => {
        const handleExit = () => {
          devServerExited = true;
          resolve();
        };

        if (activeDevServer.exitCode !== null) {
          handleExit();
        } else {
          activeDevServer.once("exit", handleExit);
        }
      });
    }

    const stopDevServer = async () => {
      if (!devServer || !devServerExitPromise) {
        return;
      }
      if (!devServerExited && devServer.exitCode === null) {
        devServer.kill("SIGTERM");
      }

      await devServerExitPromise;
    };

    let recordVideoDir = "";
    let electronApp: ElectronApplication | undefined;

    try {
      let devHost = "127.0.0.1";
      if (shouldStartDevServer) {
        devHost = process.env.MUX_DEVSERVER_HOST ?? "127.0.0.1";
        await waitForServerReady(`http://${devHost}:${devServerPort}`);
        const exitCode = devServer?.exitCode;
        if (exitCode !== null && exitCode !== undefined) {
          throw new Error(`Vite dev server exited early (code ${exitCode})`);
        }
      }

      recordVideoDir = testInfo.outputPath("electron-video");
      fs.mkdirSync(recordVideoDir, { recursive: true });

      const electronEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") {
          electronEnv[key] = value;
        }
      }
      electronEnv.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
      electronEnv.MUX_MOCK_AI = electronEnv.MUX_MOCK_AI ?? "1";
      electronEnv.MUX_ROOT = configRoot;
      electronEnv.MUX_E2E = "1";
      electronEnv.MUX_E2E_LOAD_DIST = shouldLoadDist ? "1" : "0";
      electronEnv.VITE_DISABLE_MERMAID = "1";

      if (shouldStartDevServer) {
        electronEnv.MUX_DEVSERVER_PORT = String(devServerPort);
        electronEnv.MUX_DEVSERVER_HOST = devHost;
        electronEnv.NODE_ENV = electronEnv.NODE_ENV ?? "development";
      } else {
        electronEnv.NODE_ENV = electronEnv.NODE_ENV ?? "production";
      }

      electronApp = await electron.launch({
        args: ["."],
        cwd: appRoot,
        env: electronEnv,
        recordVideo: {
          dir: recordVideoDir,
          size: { width: 1280, height: 720 },
        },
      });

      try {
        await use(electronApp);
      } finally {
        if (electronApp) {
          await electronApp.close();
        }

        const displayName = testInfo.title ?? testInfo.testId;
        if (recordVideoDir) {
          try {
            const videoFiles = await fsPromises.readdir(recordVideoDir);
            if (electronApp && videoFiles.length) {
              const videosDir = path.join(appRoot, "artifacts", "videos");
              await fsPromises.mkdir(videosDir, { recursive: true });
              const orderedFiles = [...videoFiles].sort();
              const baseName = sanitizeForPath(
                testInfo.testId || testInfo.title || "mux-e2e-video"
              );
              for (const [index, file] of orderedFiles.entries()) {
                const ext = path.extname(file) || ".webm";
                const suffix = orderedFiles.length > 1 ? `-${index}` : "";
                const destination = path.join(videosDir, `${baseName}${suffix}${ext}`);
                await fsPromises.rm(destination, { force: true });
                await fsPromises.rename(path.join(recordVideoDir, file), destination);
                console.log(`[video] saved to ${destination}`); // eslint-disable-line no-console
              }
            } else if (electronApp) {
              console.warn(`[video] no video captured for "${displayName}" at ${recordVideoDir}`); // eslint-disable-line no-console
            }
          } catch (error) {
            console.error(`[video] failed to process video for "${displayName}":`, error); // eslint-disable-line no-console
          } finally {
            await fsPromises.rm(recordVideoDir, { recursive: true, force: true });
          }
        }
      }
    } finally {
      if (shouldStartDevServer) {
        await stopDevServer();
      }
    }
  },
  page: async ({ app }, use) => {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1600, height: 900 });

    // Disable tutorials for e2e tests by marking them as completed
    // Must set before React reads the state, so we set and reload
    await window.evaluate(() => {
      const tutorialState = {
        disabled: false,
        completed: { settings: true, creation: true, workspace: true },
      };
      localStorage.setItem("tutorialState", JSON.stringify(tutorialState));
    });
    // Reload so React picks up the tutorial state on mount
    await window.reload();
    await window.waitForLoadState("domcontentloaded");

    window.on("console", (msg) => {
      // eslint-disable-next-line no-console
      console.log(`[renderer:${msg.type()}]`, msg.text());
    });
    window.on("pageerror", (error) => {
      console.error("[renderer:error]", error);
    });
    await use(window);
  },
  ui: async ({ page, workspace }, use) => {
    const helpers = createWorkspaceUI(page, workspace.demoProject);
    await use(helpers);
  },
});

export const electronExpect = expect;
