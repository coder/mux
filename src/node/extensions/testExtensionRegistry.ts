/**
 * Shared test helper: creates a real ExtensionRegistry backed by temp dirs.
 *
 * Mirrors the HistoryService convention (createTestHistoryService): no mocks;
 * a real registry composed over real GlobalExtensionStateService /
 * ProjectExtensionStateService instances and a temp `~/.mux`. Tests inject
 * roots via the `roots` option and may override `discoverFn` for stubbed
 * discovery.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";
import { GlobalExtensionStateService } from "@/node/extensions/globalExtensionStateService";
import {
  getProjectExtensionStateRoot,
  ProjectExtensionStateService,
} from "@/node/extensions/projectExtensionStateService";
import { SnapshotCacheService } from "@/node/extensions/snapshotCacheService";
import {
  ExtensionRegistry,
  type DiscoverFn,
  type ExtensionRegistryOptions,
  type RootsFn,
} from "@/node/extensions/extensionRegistryService";

export interface CreateTestExtensionRegistryOptions {
  roots?: RootsFn;
  discoverFn?: DiscoverFn;
  withSnapshotCache?: boolean;
  appVersion?: string;
  now?: () => number;
  perRootTimeoutMs?: number;
  perFileTimeoutMs?: number;
}

export interface TestExtensionRegistry {
  registry: ExtensionRegistry;
  config: Config;
  globalState: GlobalExtensionStateService;
  projectState: ProjectExtensionStateService;
  snapshotCache?: SnapshotCacheService;
  tempDir: string;
  cleanup: () => Promise<void>;
}

export async function createTestExtensionRegistry(
  options: CreateTestExtensionRegistryOptions = {}
): Promise<TestExtensionRegistry> {
  const tempDir = path.join(
    os.tmpdir(),
    `mux-test-extension-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(tempDir, { recursive: true });

  const config = new Config(tempDir);
  const globalState = new GlobalExtensionStateService(config);
  const projectState = new ProjectExtensionStateService(getProjectExtensionStateRoot(tempDir));

  let snapshotCache: SnapshotCacheService | undefined;
  let stateFilePaths: ExtensionRegistryOptions["stateFilePaths"];
  if (options.withSnapshotCache) {
    snapshotCache = new SnapshotCacheService({
      cacheFilePath: path.join(tempDir, "extension-snapshot.cache.json"),
      appVersion: options.appVersion ?? "0.0.0-test",
    });
    stateFilePaths = () => [path.join(tempDir, "config.json")];
  }

  const registry = new ExtensionRegistry({
    roots: options.roots ?? (() => []),
    globalState,
    projectState,
    snapshotCache,
    stateFilePaths,
    now: options.now,
    perRootTimeoutMs: options.perRootTimeoutMs,
    perFileTimeoutMs: options.perFileTimeoutMs,
    discoverFn: options.discoverFn,
  });

  return {
    registry,
    config,
    globalState,
    projectState,
    snapshotCache,
    tempDir,
    cleanup: async () => {
      registry.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}
