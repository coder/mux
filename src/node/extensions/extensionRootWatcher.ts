import * as fs from "fs";
import * as path from "path";

import type { ExtensionRootDescriptor } from "@/node/extensions/extensionDiscoveryService";
import { log as defaultLog, type Logger } from "@/node/services/log";

export const ROOT_WATCHER_DEBOUNCE_MS_DEFAULT = 500;

export type WatchFn = (
  target: string,
  options: fs.WatchOptions,
  listener: (event: fs.WatchEventType, filename: string | null) => void
) => fs.FSWatcher;

export interface ExtensionRootWatcherOptions {
  /** Invoked once per debounce window when an eligible event is observed. */
  onChange: () => void;
  /** Override the 500ms default; useful for tests. */
  debounceMs?: number;
  /** Override fs.watch for tests / forced graceful-degradation paths. */
  watchFn?: WatchFn;
  /** Inject a logger; defaults to the project-wide logger. */
  log?: Pick<Logger, "debug">;
}

// Watches the root manifest + lockfile for each eligible Extension Root.
// Bundled roots are never watched (they can only change via app upgrade);
// project-local roots are watched only while their Trusted Extension Root flag
// is set, and watchers are torn down when the flag flips off. fs.watch failures
// degrade silently to a debug log; the user falls back to manual Reload.
interface ActiveRootWatcher {
  rootPath: string;
  rootWatchers: fs.FSWatcher[];
  moduleWatchers: Map<string, fs.FSWatcher>;
}

export class ExtensionRootWatcher {
  private readonly active = new Map<string, ActiveRootWatcher>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly debounceMs: number;
  private readonly watchFn: WatchFn;
  private readonly onChange: () => void;
  private readonly log: Pick<Logger, "debug">;
  private closed = false;

  constructor(options: ExtensionRootWatcherOptions) {
    this.onChange = options.onChange;
    this.debounceMs = options.debounceMs ?? ROOT_WATCHER_DEBOUNCE_MS_DEFAULT;
    this.watchFn =
      options.watchFn ??
      ((target, watchOptions, listener) =>
        fs.watch(target, { ...watchOptions, encoding: "utf8" }, listener));
    this.log = options.log ?? defaultLog;
  }

  /**
   * Reconciles the active watcher set against the current Extension Roots.
   * Idempotent: re-passing identical eligible roots leaves their watchers in
   * place. Roots that become ineligible (untrusted project-local, vanished,
   * or now bundled) have their watchers closed.
   */
  async setRoots(roots: readonly ExtensionRootDescriptor[]): Promise<void> {
    if (this.closed) return;
    const eligible = new Map<string, ExtensionRootDescriptor>();
    for (const root of roots) {
      if (isWatchableRoot(root)) eligible.set(rootKey(root), root);
    }

    for (const [key, activeRoot] of this.active) {
      if (eligible.has(key)) continue;
      closeActiveRoot(activeRoot);
      this.active.delete(key);
    }

    for (const [key, root] of eligible) {
      const activeRoot = this.active.get(key);
      if (activeRoot) {
        if (activeRoot.rootPath !== root.path) {
          closeActiveRoot(activeRoot);
          this.active.delete(key);
          await this.startWatcher(key, root);
          continue;
        }
        await this.reconcileModuleWatchers(activeRoot);
        continue;
      }
      await this.startWatcher(key, root);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const activeRoot of this.active.values()) closeActiveRoot(activeRoot);
    this.active.clear();
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private async startWatcher(key: string, root: ExtensionRootDescriptor): Promise<void> {
    let watcher: fs.FSWatcher;
    try {
      watcher = this.watchFn(
        root.path,
        { persistent: false, recursive: false },
        (_event, filename) => this.onRootWatchEvent(filename)
      );
    } catch (error) {
      this.log.debug("Extension Root Watcher: fs.watch failed", root.path, error);
      return;
    }

    const activeRoot: ActiveRootWatcher = {
      rootPath: root.path,
      rootWatchers: [watcher],
      moduleWatchers: new Map(),
    };

    watcher.on("error", (error) => {
      this.log.debug("Extension Root Watcher: error event", root.path, error);
      // After an error fs.watch stops delivering events, so close + drop the
      // entry; future setRoots() calls will retry. We don't reconnect eagerly.
      if (this.active.get(key) === activeRoot) {
        closeActiveRoot(activeRoot);
        this.active.delete(key);
      }
    });

    this.startProjectLockWatcher(root, activeRoot);
    this.active.set(key, activeRoot);
    await this.reconcileModuleWatchers(activeRoot);
  }

  private startProjectLockWatcher(
    root: ExtensionRootDescriptor,
    activeRoot: ActiveRootWatcher
  ): void {
    const projectPath = projectPathFromProjectLocalRootId(root.rootId);
    if (root.kind !== "project-local" || projectPath === null) return;

    const lockDir = path.join(projectPath, ".mux");
    if (path.resolve(lockDir) === path.resolve(root.path)) return;

    try {
      const watcher = this.watchFn(
        lockDir,
        { persistent: false, recursive: false },
        (_event, filename) => this.onRootWatchEvent(filename)
      );
      watcher.on("error", (error) => {
        this.log.debug("Extension Root Watcher: project lock error event", lockDir, error);
        watcher.close();
      });
      activeRoot.rootWatchers.push(watcher);
    } catch (error) {
      // Project lockfile changes trigger source sync. If watching the repo .mux
      // directory fails, module hot reload still works and users can Reload.
      this.log.debug("Extension Root Watcher: project lock fs.watch failed", lockDir, error);
    }
  }

  private async reconcileModuleWatchers(activeRoot: ActiveRootWatcher): Promise<void> {
    const moduleWatchPaths = await findExtensionModuleWatchPaths(activeRoot.rootPath);
    const wanted = new Set(moduleWatchPaths);

    for (const [modulePath, watcher] of activeRoot.moduleWatchers) {
      if (wanted.has(modulePath)) continue;
      watcher.close();
      activeRoot.moduleWatchers.delete(modulePath);
    }

    for (const modulePath of moduleWatchPaths) {
      if (activeRoot.moduleWatchers.has(modulePath)) continue;
      let watcher: fs.FSWatcher;
      try {
        watcher = this.watchFn(
          modulePath,
          { persistent: false, recursive: false },
          (_event, filename) => this.onModuleWatchEvent(filename)
        );
      } catch (error) {
        this.log.debug("Extension Root Watcher: module fs.watch failed", modulePath, error);
        continue;
      }
      watcher.on("error", (error) => {
        this.log.debug("Extension Root Watcher: module error event", modulePath, error);
        watcher.close();
        activeRoot.moduleWatchers.delete(modulePath);
      });
      activeRoot.moduleWatchers.set(modulePath, watcher);
    }
  }

  private onRootWatchEvent(filename: string | null): void {
    // Some platforms deliver `null` for the filename; treat as relevant so we
    // never miss a real change. Otherwise filter to a direct Extension Module
    // directory / manifest path; package-manager metadata is ignored in v1.
    if (filename !== null && !isRelevantRootFilename(filename)) return;
    this.scheduleReload();
  }

  private onModuleWatchEvent(filename: string | null): void {
    // Module directory watchers exist so editing <module>/extension.ts, nested imports,
    // or body files triggers rediscovery even where root fs.watch is not recursive.
    if (filename !== null && !isRelevantModuleFilename(filename)) return;
    this.scheduleReload();
  }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      try {
        this.onChange();
      } catch (error) {
        this.log.debug("Extension Root Watcher: onChange threw", error);
      }
    }, this.debounceMs);
  }
}

function closeActiveRoot(activeRoot: ActiveRootWatcher): void {
  for (const rootWatcher of activeRoot.rootWatchers) rootWatcher.close();
  for (const moduleWatcher of activeRoot.moduleWatchers.values()) moduleWatcher.close();
  activeRoot.moduleWatchers.clear();
}

async function findExtensionModuleWatchPaths(rootPath: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  let rootRealPath: string;
  try {
    rootRealPath = await fs.promises.realpath(rootPath);
  } catch {
    return [];
  }

  const watchPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!isExtensionModuleName(entry.name)) continue;
    const modulePath = path.join(rootPath, entry.name);
    let hasEntrypoint = false;
    try {
      const moduleRealPath = await fs.promises.realpath(modulePath);
      if (!isContainedRealPath(rootRealPath, moduleRealPath)) continue;
      const stat = await fs.promises.stat(moduleRealPath);
      if (!stat.isDirectory()) continue;
      try {
        await fs.promises.access(path.join(modulePath, "extension.ts"));
        hasEntrypoint = true;
      } catch {
        hasEntrypoint = false;
      }
    } catch {
      continue;
    }
    watchPaths.push(modulePath);
    if (hasEntrypoint) watchPaths.push(...(await findNestedDirectoryPaths(modulePath)));
  }
  return watchPaths;
}

const IGNORED_MODULE_WATCH_DIR_NAMES = new Set([".git", "node_modules"]);

async function findNestedDirectoryPaths(rootPath: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_MODULE_WATCH_DIR_NAMES.has(entry.name)) continue;
    const dirPath = path.join(rootPath, entry.name);
    dirs.push(dirPath);
    dirs.push(...(await findNestedDirectoryPaths(dirPath)));
  }
  return dirs;
}

function isContainedRealPath(rootRealPath: string, candidateRealPath: string): boolean {
  const relativePath = path.relative(rootRealPath, candidateRealPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isRelevantModuleFilename(filename: string): boolean {
  return filename.split(/[\\/]/u).some(Boolean);
}

function isExtensionModuleName(filename: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(filename);
}

function isRelevantRootFilename(filename: string): boolean {
  const parts = filename.split(/[\\/]/u).filter(Boolean);
  if (parts.length === 1) {
    return (
      isExtensionModuleName(parts[0]) ||
      parts[0] === "extensions.lock.json" ||
      parts[0] === "lock.json"
    );
  }
  return parts.length === 2 && isExtensionModuleName(parts[0]) && parts[1] === "extension.ts";
}

function projectPathFromProjectLocalRootId(rootId: string): string | null {
  const prefix = "project-local:";
  if (!rootId.startsWith(prefix)) return null;
  return rootId.slice(prefix.length);
}

function rootKey(root: ExtensionRootDescriptor): string {
  return `${root.kind}:${root.rootId}`;
}

function isWatchableRoot(root: ExtensionRootDescriptor): boolean {
  if (root.kind === "bundled") return false;
  if (root.kind === "project-local") return root.trusted === true;
  return true;
}
