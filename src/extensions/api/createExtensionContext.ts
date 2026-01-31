import type { HostApi } from "./HostApi";
import type { RightSidebarTabContribution, ExtensionRegistry } from "../registry/ExtensionRegistry";

export interface ExtensionStorage {
  get: <T>(key: string, defaultValue: T) => T;
  set: <T>(key: string, value: T) => void;
  update: <T>(key: string, updater: (prev: T) => T, defaultValue: T) => void;
}

export interface ExtensionContributionsApi {
  rightSidebar: {
    registerTab: (contribution: RightSidebarTabContribution) => () => void;
  };
}

export interface ExtensionContext {
  extensionId: string;
  host: HostApi;
  storage: ExtensionStorage;
  contribute: ExtensionContributionsApi;
}

function makeNamespacedStorageKey(extensionId: string, key: string): string {
  return `extensions:${extensionId}:${key}`;
}

export function createExtensionContext(params: {
  extensionId: string;
  registry: ExtensionRegistry;
  hostApi: HostApi;
}): ExtensionContext {
  const storage: ExtensionStorage = {
    get: <T>(key: string, defaultValue: T) =>
      params.hostApi.storage.read(makeNamespacedStorageKey(params.extensionId, key), defaultValue),
    set: <T>(key: string, value: T) =>
      params.hostApi.storage.update(makeNamespacedStorageKey(params.extensionId, key), value),
    update: <T>(key: string, updater: (prev: T) => T, defaultValue: T) =>
      params.hostApi.storage.update(
        makeNamespacedStorageKey(params.extensionId, key),
        updater,
        defaultValue
      ),
  };

  const contribute: ExtensionContributionsApi = {
    rightSidebar: {
      registerTab: (contribution) => params.registry.registerRightSidebarTab(contribution),
    },
  };

  return {
    extensionId: params.extensionId,
    host: params.hostApi,
    storage,
    contribute,
  };
}
