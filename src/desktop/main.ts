// Enable source map support for better error stack traces in production
import "source-map-support/register";

// Fix PATH on macOS when launched from Finder (not terminal).
// GUI apps inherit minimal PATH from launchd, missing Homebrew tools like git-lfs.
// Must run before any child process spawns. Failures are silently ignored.
if (process.platform === "darwin") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("fix-path") as { default: () => void }).default();
  } catch (e) {
    // App works with existing PATH; debug log for troubleshooting
    console.debug("[fix-path] Failed to enrich PATH:", e);
  }
}

import { randomBytes } from "crypto";
import { RPCHandler } from "@orpc/server/message-port";
import { onError } from "@orpc/server";
import { router } from "../node/orpc/router";
import { formatOrpcError } from "../node/orpc/formatOrpcError";
import { ServerLockfile } from "../node/services/serverLockfile";
import "disposablestack/auto";

import type { MenuItemConstructorOptions, MessageBoxOptions } from "electron";
import {
  app,
  BrowserWindow,
  ipcMain as electronIpcMain,
  Menu,
  Tray,
  dialog,
  nativeImage,
  nativeTheme,
  screen,
  shell,
} from "electron";

// Increase renderer V8 heap limit from default ~4GB to 8GB.
// At ~3.9GB usage, the default limit causes frequent Mark-Compact GC cycles
// with low mutator utilization (~39%), degrading UI responsiveness.
// Must be called before app.whenReady().
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");

import * as fs from "fs";
import * as path from "path";
import type { Config } from "../node/config";
import type { ServiceContainer } from "../node/services/serviceContainer";
import { VERSION } from "../version";
import { getMuxHome, migrateLegacyMuxHome } from "../common/constants/paths";
import type { MuxDeepLinkPayload } from "../common/types/deepLink";
import type { UpdateStatus } from "../common/orpc/types";
import { parseMuxDeepLink } from "../common/utils/deepLink";

import assert from "../common/utils/assert";
import { setOpenSSHHostKeyPolicyMode } from "@/node/runtime/sshConnectionPool";
import { loadTokenizerModules } from "../node/utils/main/tokenizer";
import { isBashAvailable } from "../node/utils/main/bashPath";
import windowStateKeeper from "electron-window-state";
import { getTitleBarOptions } from "./titleBarOptions";
import { isUpdateInstallInProgress } from "./updateInstallState";
import { getErrorMessage } from "@/common/utils/errors";

// React DevTools for development profiling
// Using dynamic import() to avoid loading electron-devtools-installer at module init time

// IMPORTANT: Lazy-load heavy dependencies to maintain fast startup time
//
// To keep startup time under 4s, avoid importing AI SDK packages at the top level.
// These files MUST use dynamic import():
//   - main.ts, config.ts, preload.ts (startup-critical)
//
// ✅ GOOD: const { createAnthropic } = await import("@ai-sdk/anthropic");
// ❌ BAD:  import { createAnthropic } from "@ai-sdk/anthropic";
//
// Enforcement: scripts/check_eager_imports.sh validates this in CI
//
// Lazy-load Config and ServiceContainer to avoid loading heavy AI SDK dependencies at startup
// These will be loaded on-demand when createWindow() is called
let config: Config | null = null;
let services: ServiceContainer | null = null;
const isE2ETest = process.env.MUX_E2E === "1";
const forceDistLoad = process.env.MUX_E2E_LOAD_DIST === "1";

if (isE2ETest) {
  // For e2e tests, use a test-specific userData directory
  // Note: getMuxHome() already respects MUX_ROOT for test isolation
  const e2eUserData = path.join(getMuxHome(), "user-data");
  try {
    fs.mkdirSync(e2eUserData, { recursive: true });
    app.setPath("userData", e2eUserData);
    console.log("Using test userData directory:", e2eUserData);
  } catch (error) {
    console.warn("Failed to prepare test userData directory:", error);
  }
}

const devServerPort = process.env.MUX_DEVSERVER_PORT ?? "5173";

console.log(
  `Mux starting - version: ${(VERSION as { git?: string; buildTime?: string }).git ?? "(dev)"} (built: ${(VERSION as { git?: string; buildTime?: string }).buildTime ?? "dev-mode"})`
);
console.log("Main process starting...");

// Debug: abort immediately if MUX_DEBUG_START_TIME is set
// This is used to measure baseline startup time without full initialization
if (process.env.MUX_DEBUG_START_TIME === "1") {
  console.log("MUX_DEBUG_START_TIME is set - aborting immediately");
  process.exit(0);
}

// Global error handlers for better error reporting
process.on("uncaughtException", (error: unknown) => {
  console.error("Uncaught Exception:", error);

  const message = getErrorMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error("Stack:", stack);

  // Show error dialog in production
  if (app.isPackaged) {
    dialog.showErrorBox(
      "Application Error",
      `An unexpected error occurred:\n\n${message}\n\nStack trace:\n${stack ?? "No stack trace available"}`
    );
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise);
  console.error("Reason:", reason);

  if (app.isPackaged) {
    const message = getErrorMessage(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    dialog.showErrorBox(
      "Unhandled Promise Rejection",
      `An unhandled promise rejection occurred:\n\n${message}\n\nStack trace:\n${stack ?? "No stack trace available"}`
    );
  }
});

// Single instance lock (can be disabled for development with CMUX_ALLOW_MULTIPLE_INSTANCES=1)
const allowMultipleInstances = process.env.CMUX_ALLOW_MULTIPLE_INSTANCES === "1";
const gotTheLock = allowMultipleInstances || app.requestSingleInstanceLock();
console.log("Single instance lock acquired:", gotTheLock);

if (!gotTheLock) {
  // Another instance is already running, quit this one
  console.log("Another instance is already running, quitting...");
  app.quit();
} else {
  // This is the primary instance
  console.log("This is the primary instance");
  app.on("second-instance", (_event, argv) => {
    // Someone tried to run a second instance, focus our window instead
    console.log("Second instance attempted to start");

    try {
      handleArgvMuxDeepLinks(argv);
    } catch (error) {
      console.debug("[deep-link] Failed to parse second-instance argv for mux deep links:", error);
    }

    focusMainWindow();
  });
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let latestUpdateStatus: UpdateStatus = { type: "idle" };
let isUpdateClosePromptOpen = false;

// mux:// deep links can arrive before the main window exists / finishes loading.
const bufferedMuxDeepLinks: MuxDeepLinkPayload[] = [];
let mainWindowFinishedLoading = false;

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  // Closing Mux on Windows hides to tray; show it again when a second-instance launch occurs.
  mainWindow.show();
  mainWindow.focus();
}

function flushBufferedMuxDeepLinks() {
  if (!mainWindow || !mainWindowFinishedLoading) return;

  while (bufferedMuxDeepLinks.length > 0) {
    const payload = bufferedMuxDeepLinks[0];
    try {
      mainWindow.webContents.send("mux:deep-link", payload);
      bufferedMuxDeepLinks.shift();
    } catch (error) {
      // Best-effort: never crash startup if the renderer isn't ready.
      console.debug("[deep-link] Failed to send mux deep link payload:", error);
      return;
    }
  }
}

function handleMuxDeepLink(raw: string) {
  try {
    const payload = parseMuxDeepLink(raw);
    if (!payload) return;

    // Buffer until the renderer has finished loading.
    if (!mainWindow || !mainWindowFinishedLoading) {
      bufferedMuxDeepLinks.push(payload);
      return;
    }

    mainWindow.webContents.send("mux:deep-link", payload);
  } catch (error) {
    // Best-effort: never crash startup if argv parsing/protocol handling is weird.
    console.debug(`[deep-link] Failed to handle mux deep link: ${raw}`, error);
  }
}

function handleArgvMuxDeepLinks(argv: string[]) {
  for (const arg of argv) {
    if (arg.startsWith("mux:")) {
      handleMuxDeepLink(arg);
    }
  }
}

// macOS deep links arrive via open-url (must be registered before ready)
if (process.platform === "darwin") {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleMuxDeepLink(url);
    focusMainWindow();
  });
}

// Initial launch: Windows/Linux deep links are passed in argv.
try {
  handleArgvMuxDeepLinks(process.argv);
} catch (error) {
  console.debug("[deep-link] Failed to parse initial argv for mux deep links:", error);
}

function registerMuxProtocolClient() {
  try {
    if (!app.isPackaged && process.defaultApp && process.argv[1]) {
      // On Windows dev builds, Electron needs the executable + app path to register.
      app.setAsDefaultProtocolClient("mux", process.execPath, [path.resolve(process.argv[1])]);
      return;
    }

    app.setAsDefaultProtocolClient("mux");
  } catch (error) {
    // Best-effort: never crash startup if protocol registration fails.
    console.debug("[deep-link] Failed to register mux:// protocol handler:", error);
  }
}

/**
 * Format timestamp as HH:MM:SS.mmm for readable logging
 */
function timestamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

function createMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // Reload without Ctrl+R shortcut (reserved for Code Review refresh)
        {
          label: "Reload",
          click: (_item, focusedWindow) => {
            if (focusedWindow && "reload" in focusedWindow) {
              (focusedWindow as BrowserWindow).reload();
            }
          },
        },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        // Bind zoom-in to Ctrl/Cmd+= so the standard shortcut works without requiring Shift.
        { role: "zoomIn", accelerator: "CommandOrControl+=" },
        { role: "zoomOut" },
        { type: "separator" },
        {
          role: "togglefullscreen",
          accelerator: process.platform === "darwin" ? "Ctrl+Command+F" : "F11",
        },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "Cmd+,",
          click: () => {
            services?.menuEventService.emitOpenSettings();
          },
        },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * System tray (Windows/Linux) / menu bar (macOS) icon.
 *
 * - macOS: use a template image (always the black asset) so the system
 *   automatically adapts to light/dark menu bar appearances.
 * - Windows/Linux: switch between black/white assets based on the OS theme.
 *
 * Tray icon assets are expected in the built dist root (copied from /public),
 * alongside splash.html.
 */
function getTrayIconPath(): string {
  if (process.platform === "darwin") {
    return path.join(__dirname, "../tray-icon-black.png");
  }

  const fileName = nativeTheme.shouldUseDarkColors ? "tray-icon-white.png" : "tray-icon-black.png";
  return path.join(__dirname, `../${fileName}`);
}

function loadTrayIconImage() {
  const iconPath = getTrayIconPath();

  // Tray icons are 24×24 PNGs with cropped viewBox. We manually add @2x and
  // @3x representations so macOS picks the sharpest variant for the display's
  // scale factor. Electron auto-detects @2x from the path naming convention
  // but only when both files exist – and it doesn't look for @3x at all.
  const image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    console.warn(`[${timestamp()}] [tray] Tray icon missing or unreadable: ${iconPath}`);
    return null;
  }

  for (const scaleFactor of [2, 3] as const) {
    const hqPath = iconPath.replace(/\.png$/, `@${scaleFactor}x.png`);
    const hqImage = nativeImage.createFromPath(hqPath);
    if (!hqImage.isEmpty()) {
      image.addRepresentation({ scaleFactor, buffer: hqImage.toPNG() });
    }
  }

  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }

  return image;
}

function openMuxFromTray() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  // On macOS the app stays open after all windows are closed; recreate the window.
  if (process.platform === "darwin") {
    if (!services) {
      console.warn(`[${timestamp()}] [tray] Cannot open mux (services not loaded yet)`);
      return;
    }

    createWindow();
  }
}

function updateTrayIcon() {
  if (!tray) return;

  const image = loadTrayIconImage();
  if (!image) {
    return;
  }

  tray.setImage(image);
}

function createTray() {
  if (tray) return;

  const image = loadTrayIconImage();
  if (!image) {
    console.warn(`[${timestamp()}] [tray] Skipping tray creation (icon unavailable)`);
    return;
  }

  try {
    tray = new Tray(image);
  } catch (error) {
    console.warn(`[${timestamp()}] [tray] Failed to create tray:`, error);
    tray = null;
    return;
  }

  const menu = Menu.buildFromTemplate([
    {
      label: "Open mux",
      click: () => {
        openMuxFromTray();
      },
    },
    {
      label: "Exit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  // Best-effort: update tray icon when OS appearance changes.
  nativeTheme.on("updated", () => {
    updateTrayIcon();
  });
}

/**
 * Create and show splash screen - instant visual feedback (<100ms)
 *
 * Shows a lightweight native window with static HTML while services load.
 * No IPC, no React, no heavy dependencies - just immediate user feedback.
 */
async function showSplashScreen() {
  const startTime = Date.now();
  console.log(`[${timestamp()}] Showing splash screen...`);

  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: false,
    backgroundColor: "#1f1f1f", // Match splash HTML background (hsl(0 0% 12%)) - prevents white flash
    alwaysOnTop: true,
    center: true,
    resizable: false,
    show: false, // Don't show until HTML is loaded
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Wait for splash HTML to load
  await splashWindow.loadFile(path.join(__dirname, "../splash.html"));

  // Wait for the window to actually be shown and rendered before continuing
  // This ensures the splash is visible before we block the event loop with heavy work
  await new Promise<void>((resolve) => {
    splashWindow!.once("show", () => {
      const loadTime = Date.now() - startTime;
      console.log(`[${timestamp()}] Splash screen shown (${loadTime}ms)`);
      // Give one more event loop tick for the window to actually paint
      setImmediate(resolve);
    });
    splashWindow!.show();
  });

  splashWindow.on("closed", () => {
    console.log(`[${timestamp()}] Splash screen closed event`);
    splashWindow = null;
  });
}

/**
 * Close splash screen
 */
function closeSplashScreen() {
  if (splashWindow) {
    console.log(`[${timestamp()}] Closing splash screen...`);
    splashWindow.close();
    splashWindow = null;
  }
}

/**
 * Load backend services (Config, ServiceContainer, AI SDK, tokenizer)
 *
 * Heavy initialization (~100ms) happens here while splash is visible.
 * Note: Spinner may freeze briefly during this phase. This is acceptable since
 * the splash still provides visual feedback that the app is loading.
 */
async function loadServices(): Promise<void> {
  if (config && services) return; // Already loaded

  const startTime = Date.now();
  console.log(`[${timestamp()}] Loading services...`);

  /* eslint-disable no-restricted-syntax */
  // Dynamic imports are justified here for performance:
  // - ServiceContainer transitively imports the entire AI SDK (ai, @ai-sdk/anthropic, etc.)
  // - These are large modules (~100ms load time) that would block splash from appearing
  // - Loading happens once, then cached
  const [
    { Config: ConfigClass },
    { ServiceContainer: ServiceContainerClass },
    { TerminalWindowManager: TerminalWindowManagerClass },
  ] = await Promise.all([
    import("../node/config"),
    import("../node/services/serviceContainer"),
    import("./terminalWindowManager"),
  ]);
  /* eslint-enable no-restricted-syntax */
  config = new ConfigClass();

  services = new ServiceContainerClass(config);
  // Desktop bootstrap owns interactive host-key trust policy
  setOpenSSHHostKeyPolicyMode("strict");
  await services.initialize();
  // Keep the latest update status in main so close-to-tray can prompt for installs.
  services.updateService.onStatus((status) => {
    latestUpdateStatus = status;
  });

  // Generate auth token (use env var or random per-session)
  const authToken = process.env.MUX_SERVER_AUTH_TOKEN ?? randomBytes(32).toString("hex");

  // Store auth token so the API server can be restarted via Settings.
  services.serverService.setApiAuthToken(authToken);

  // Single router instance with auth middleware - used for both MessagePort and HTTP/WS
  const orpcRouter = router(authToken);

  const orpcHandler = new RPCHandler(orpcRouter, {
    interceptors: [
      onError((error, options) => {
        const formatted = formatOrpcError(error, options);
        console.error(formatted.message);
      }),
    ],
  });

  const orpcContext = services.toORPCContext();

  electronIpcMain.handle("mux:get-is-rosetta", async () => {
    if (process.platform !== "darwin") {
      return false;
    }

    try {
      // Intentionally lazy import to keep startup fast and avoid bundling concerns.
      // eslint-disable-next-line no-restricted-syntax -- main-process-only builtin
      const { execSync } = await import("node:child_process");
      const result = execSync("sysctl -n sysctl.proc_translated", { encoding: "utf8" }).trim();
      return result === "1";
    } catch {
      return false;
    }
  });
  electronIpcMain.handle("mux:get-is-windows-wsl-shell", async () => {
    if (process.platform !== "win32") return false;

    const normalize = (p: string) => p.replace(/\//g, "\\").toLowerCase();
    const isWslLauncher = (p: string) => {
      const base = path.win32.basename(p);
      return (
        p === "wsl" ||
        base === "wsl.exe" ||
        p === "bash" ||
        p === "bash.exe" ||
        p.endsWith("\\windows\\system32\\bash.exe")
      );
    };

    // Check if the default shell appears to be WSL.
    let looksLikeWsl = false;

    const envShell = process.env.SHELL?.trim();
    if (envShell && isWslLauncher(normalize(envShell))) {
      looksLikeWsl = true;
    } else {
      try {
        // Intentionally lazy import to keep startup fast and avoid bundling concerns.
        // eslint-disable-next-line no-restricted-syntax -- main-process-only builtin
        const { execSync } = await import("node:child_process");
        const result = execSync("where bash", {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
        const firstPath = result
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0);

        looksLikeWsl = firstPath ? isWslLauncher(normalize(firstPath)) : false;
      } catch {
        // Ignore
      }
    }

    // Even if WSL is the default, don't warn if Git for Windows bash is available
    // (Mux will use that instead).
    if (looksLikeWsl && isBashAvailable()) {
      return false;
    }

    return looksLikeWsl;
  });

  electronIpcMain.on("start-orpc-server", (event) => {
    const [serverPort] = event.ports;
    orpcHandler.upgrade(serverPort, {
      context: {
        ...orpcContext,
        // Inject synthetic auth header so auth middleware passes
        headers: { authorization: `Bearer ${authToken}` },
      },
    });
    serverPort.start();
  });

  // Start HTTP/WS API server for CLI access (unless explicitly disabled)
  if (process.env.MUX_NO_API_SERVER !== "1") {
    const lockfile = new ServerLockfile(config.rootDir);
    const existing = await lockfile.read();

    if (existing) {
      console.log(`[${timestamp()}] API server already running at ${existing.baseUrl}, skipping`);
    } else {
      try {
        const loadedConfig = config.loadConfigOrDefault();
        const configuredBindHost =
          typeof loadedConfig.apiServerBindHost === "string" &&
          loadedConfig.apiServerBindHost.trim()
            ? loadedConfig.apiServerBindHost.trim()
            : undefined;
        const serveStatic = loadedConfig.apiServerServeWebUi === true;
        const configuredPort = loadedConfig.apiServerPort;

        const envPortRaw = process.env.MUX_SERVER_PORT
          ? Number.parseInt(process.env.MUX_SERVER_PORT, 10)
          : undefined;
        const envPort =
          envPortRaw !== undefined && Number.isFinite(envPortRaw) ? envPortRaw : undefined;

        const port = envPort ?? configuredPort ?? 0;
        const host = configuredBindHost ?? "127.0.0.1";

        const serverInfo = await services.serverService.startServer({
          muxHome: config.rootDir,
          context: orpcContext,
          router: orpcRouter,
          authToken,
          host,
          serveStatic,
          port,
        });
        console.log(`[${timestamp()}] API server started at ${serverInfo.baseUrl}`);
      } catch (error) {
        console.error(`[${timestamp()}] Failed to start API server:`, error);
        // Non-fatal - continue without API server
      }
    }
  }

  // Set TerminalWindowManager for desktop mode (pop-out terminal windows)
  const terminalWindowManager = new TerminalWindowManagerClass(config);
  services.setProjectDirectoryPicker(async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;

    const res = await dialog.showOpenDialog(win, {
      // Hide hidden entries so the new-project picker stays focused on visible folders.
      properties: ["openDirectory", "createDirectory"],
      title: "Select Project Directory",
      buttonLabel: "Select Project",
    });

    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  services.setTerminalWindowManager(terminalWindowManager);

  loadTokenizerModules().catch((error) => {
    console.error("Failed to preload tokenizer modules:", error);
  });

  // Initialize updater service in packaged builds or when DEBUG_UPDATER is set
  // Moved to UpdateService (services.updateService)

  const loadTime = Date.now() - startTime;
  console.log(`[${timestamp()}] Services loaded in ${loadTime}ms`);
}

function createWindow() {
  assert(services, "Services must be loaded before creating window");

  mainWindowFinishedLoading = false;

  // Calculate default window size (80% of screen)
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;

  // Load saved window state with fallback to defaults
  const windowState = windowStateKeeper({
    defaultWidth: Math.max(1200, Math.floor(screenWidth * 0.8)),
    defaultHeight: Math.max(800, Math.floor(screenHeight * 0.8)),
  });

  console.log(`[${timestamp()}] [window] Creating BrowserWindow...`);

  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "../preload.js"),
    },
    title: "mux - coder multiplexer",
    // Hide menu bar on Linux by default (like VS Code)
    // User can press Alt to toggle it
    autoHideMenuBar: process.platform === "linux",
    show: false, // Don't show until ready-to-show event
    // VSCode-like integrated titlebar (hidden native titlebar with native window controls)
    ...getTitleBarOptions(),
  });

  // Track window state (handles resize, move, maximize, fullscreen)
  windowState.manage(mainWindow);

  // Register window service with the main window
  console.log(`[${timestamp()}] [window] Registering window service...`);
  services.windowService.setMainWindow(mainWindow);

  mainWindow.on("close", (event) => {
    // Close-to-tray behavior: when the user closes the main window, keep mux
    // running in the tray/menu bar so it can be re-opened from there.
    //
    // Only hide when the tray exists to avoid trapping the user with no UI path
    // to restore the app.
    if (isQuitting || isUpdateInstallInProgress() || !tray) {
      return;
    }

    if (latestUpdateStatus.type === "downloaded") {
      // If an update is ready, prompt before hiding to tray so users can install immediately.
      event.preventDefault();

      if (isUpdateClosePromptOpen) {
        return;
      }

      isUpdateClosePromptOpen = true;
      const messageBoxOptions: MessageBoxOptions = {
        type: "question",
        buttons: ["Install & restart", "Later", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        message: "An update is ready to install.",
        detail: "Install now to restart and apply the update, or keep Mux running in the tray.",
      };

      const promptWindow = mainWindow;
      const prompt = promptWindow
        ? dialog.showMessageBox(promptWindow, messageBoxOptions)
        : dialog.showMessageBox(messageBoxOptions);

      void prompt
        .then(({ response }) => {
          if (response === 0) {
            services?.updateService.install();
            return;
          }

          if (response === 1) {
            mainWindow?.hide();
          }
        })
        .finally(() => {
          isUpdateClosePromptOpen = false;
        });
      return;
    }

    event.preventDefault();
    mainWindow?.hide();
  });

  // Show window once it's ready and close splash
  console.time("main window startup");
  mainWindow.once("ready-to-show", () => {
    console.log(`[${timestamp()}] Main window ready to show`);
    mainWindow?.show();
    closeSplashScreen();
    console.timeEnd("main window startup");
  });

  // Open all external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentOrigin = new URL(mainWindow!.webContents.getURL()).origin;
    const targetOrigin = new URL(url).origin;
    // Prevent navigation away from app origin, open externally instead
    if (targetOrigin !== currentOrigin) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Load from dev server in development, built files in production
  // app.isPackaged is true when running from a built .app/.exe, false in development
  console.log(`[${timestamp()}] [window] Loading content...`);
  console.time("[window] Content load");
  if ((isE2ETest && !forceDistLoad) || (!app.isPackaged && !forceDistLoad)) {
    // Development mode: load from vite dev server
    const devHost = process.env.MUX_DEVSERVER_HOST ?? "127.0.0.1";
    const url = `http://${devHost}:${devServerPort}`;
    console.log(`[${timestamp()}] [window] Loading from dev server: ${url}`);
    void mainWindow.loadURL(url);
    if (!isE2ETest) {
      mainWindow.webContents.once("did-finish-load", () => {
        mainWindow?.webContents.openDevTools();
      });
    }
  } else {
    // Production mode: load built files
    const htmlPath = path.join(__dirname, "../index.html");
    console.log(`[${timestamp()}] [window] Loading from file: ${htmlPath}`);
    void mainWindow.loadFile(htmlPath);
  }

  // Track when content finishes loading
  mainWindow.webContents.once("did-finish-load", () => {
    console.timeEnd("[window] Content load");
    console.log(`[${timestamp()}] [window] Content finished loading`);

    mainWindowFinishedLoading = true;
    flushBufferedMuxDeepLinks();

    // NOTE: Tokenizer modules are NOT loaded at startup anymore!
    // The Proxy in tokenizer.ts loads them on-demand when first accessed.
    // This reduces startup time from ~8s to <1s.
    // First token count will use approximation, accurate count caches in background.
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    mainWindowFinishedLoading = false;
  });
}

// Only setup app handlers if we got the lock
if (gotTheLock) {
  void app.whenReady().then(async () => {
    try {
      console.log("App ready, creating window...");

      registerMuxProtocolClient();

      // Migrate from .cmux to .mux directory structure if needed
      migrateLegacyMuxHome();

      // Install React DevTools in development
      if (!app.isPackaged) {
        try {
          const { default: installExtension, REACT_DEVELOPER_TOOLS } =
            // eslint-disable-next-line no-restricted-syntax -- dev-only dependency, intentionally lazy-loaded
            await import("electron-devtools-installer");
          const extension = await installExtension(REACT_DEVELOPER_TOOLS, {
            loadExtensionOptions: { allowFileAccess: true },
          });
          console.log(`✅ React DevTools installed: ${extension.name} (id: ${extension.id})`);
        } catch (err) {
          console.log("❌ Error installing React DevTools:", err);
        }
      }

      createMenu();

      // Three-phase startup:
      // 1. Show splash immediately (<100ms) and wait for it to load
      // 2. Load services while splash visible (fast - ~100ms)
      // 3. Create window and start loading content (splash stays visible)
      // 4. When window ready-to-show: close splash, show main window
      //
      // Skip splash in E2E tests to avoid app.firstWindow() grabbing the wrong window
      if (!isE2ETest) {
        await showSplashScreen(); // Wait for splash to actually load
      }
      await loadServices();
      createWindow();
      createTray();
      // Note: splash closes in ready-to-show event handler

      // Tokenizer modules load in background after did-finish-load event (see createWindow())
    } catch (error) {
      console.error(`[${timestamp()}] Startup failed:`, error);

      closeSplashScreen();

      // Show error dialog to user
      const errorMessage =
        error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);

      dialog.showErrorBox(
        "Startup Failed",
        `The application failed to start:\n\n${errorMessage}\n\nPlease check the console for details.`
      );

      // Quit after showing error
      app.quit();
    }
  });

  // Track if we're in the middle of disposing to prevent re-entry
  let isDisposing = false;

  app.on("before-quit", (event) => {
    // Ensure window close handlers don't block an explicit quit.
    // IMPORTANT: must be set before any early returns.
    isQuitting = true;
    if (isUpdateInstallInProgress()) {
      // Don't block updater-driven quitAndInstall() — let Electron quit immediately
      // so the platform installer can take over. Best-effort cleanup only.
      if (services && !isDisposing) {
        isDisposing = true;
        void services.dispose().catch((err) => {
          console.error("Error during ServiceContainer dispose (update install):", err);
        });
      }
      return;
    }

    // Skip if already disposing or no services to clean up
    if (isDisposing || !services) {
      return;
    }

    // Prevent quit, clean up, then quit again
    event.preventDefault();
    isDisposing = true;

    // Race dispose against timeout to ensure app quits even if disposal hangs
    const disposePromise = services.dispose().catch((err) => {
      console.error("Error during ServiceContainer dispose:", err);
    });
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000));

    void Promise.race([disposePromise, timeoutPromise]).finally(() => {
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    console.log(`[${timestamp()}] App before-quit - cleaning up...`);
    if (services) {
      void services.serverService.stopServer();
      void services.shutdown();
    }
  });

  app.on("activate", () => {
    // Skip splash on reactivation - services already loaded, window creation is fast.
    // Clicking the Dock icon should also re-open the existing window if it was
    // hidden by close-to-tray.
    // Guard: services must be loaded (prevents race if activate fires during startup).
    if (app.isReady() && services) {
      openMuxFromTray();
    }
  });
}
