import { installDom } from "../../../tests/ui/dom";

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { z } from "zod";

import type * as extensionRegistrySchemas from "@/common/orpc/schemas/extensionRegistry";
import { CommandIds } from "@/browser/utils/commandIds";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  CommandRegistryProvider,
  useCommandRegistry,
} from "@/browser/contexts/CommandRegistryContext";
import {
  buildExtensionsPaletteCommands,
  useExtensionsPaletteSource,
} from "./useExtensionsPaletteSource";

type RegistrySnapshot = z.infer<typeof extensionRegistrySchemas.RegistrySnapshotSchema>;

function makeSnapshot(overrides: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
  return {
    generatedAt: 0,
    roots: [],
    availableContributions: [],
    resolverDiagnostics: [],
    descriptors: [],
    permissions: {},
    staleRecords: [],
    ...overrides,
  };
}

type RootDiscoveryResult = z.infer<typeof extensionRegistrySchemas.RootDiscoveryResultSchema>;

function makeRoot(overrides: Partial<RootDiscoveryResult> = {}): RootDiscoveryResult {
  return {
    rootId: overrides.rootId ?? "root-id",
    kind: overrides.kind ?? "user-global",
    path: overrides.path ?? "/some/path",
    trusted: overrides.trusted ?? true,
    rootExists: overrides.rootExists ?? true,
    state: overrides.state ?? "ready",
    extensions: overrides.extensions ?? [],
    diagnostics: overrides.diagnostics ?? [],
  };
}

const fakeApi = { extensions: {} } as unknown as Parameters<
  typeof buildExtensionsPaletteCommands
>[0]["api"];

function visibleIds(commands: ReturnType<typeof buildExtensionsPaletteCommands>): string[] {
  return commands.filter((c) => !c.visible || c.visible()).map((c) => c.id);
}

function emptyAsyncIterable(): AsyncIterable<void> {
  return {
    async *[Symbol.asyncIterator]() {
      // Empty async iterable used by hook tests.
    },
  };
}

function renderPaletteHook(input: {
  api: APIClient;
  onOpenSettings: ((section?: string) => void) | undefined;
}) {
  const wrapper: React.FC<{ children: React.ReactNode }> = (props) =>
    React.createElement(
      APIProvider,
      { client: input.api } as React.ComponentProps<typeof APIProvider>,
      React.createElement(CommandRegistryProvider, null, props.children)
    );
  return renderHook(
    () => {
      useExtensionsPaletteSource(input.onOpenSettings);
      return useCommandRegistry();
    },
    { wrapper }
  );
}

let cleanupDom: (() => void) | null = null;

beforeEach(() => {
  cleanupDom = installDom();
});

afterEach(() => {
  cleanup();
  cleanupDom?.();
  cleanupDom = null;
});

describe("buildExtensionsPaletteCommands", () => {
  test("disabled hook registers no commands and does not subscribe to extension snapshots", async () => {
    const list = mock(() => Promise.resolve(makeSnapshot()));
    const onChanged = mock(() => Promise.resolve(emptyAsyncIterable()));
    const api = { extensions: { list, onChanged } } as unknown as APIClient;

    const { result } = renderPaletteHook({ api, onOpenSettings: undefined });

    await waitFor(() => expect(result.current.getActions()).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(list).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("always exposes Open Settings and Reload, regardless of snapshot state", () => {
    const cmds = buildExtensionsPaletteCommands({
      api: null,
      snapshot: null,
      onOpenSettings: () => undefined,
    });
    const ids = visibleIds(cmds);
    expect(ids).toContain(CommandIds.extensionsOpenSettings());
    expect(ids).toContain(CommandIds.extensionsReload());
  });

  test("Initialize User Root only visible when user-global root is missing", () => {
    const presentRoots = makeSnapshot({
      roots: [makeRoot({ kind: "user-global", rootExists: true })],
    });
    expect(
      visibleIds(
        buildExtensionsPaletteCommands({
          api: fakeApi,
          snapshot: presentRoots,
          onOpenSettings: () => undefined,
        })
      )
    ).not.toContain(CommandIds.extensionsInitializeUserRoot());

    const missing = makeSnapshot({
      roots: [makeRoot({ kind: "user-global", rootExists: false })],
    });
    expect(
      visibleIds(
        buildExtensionsPaletteCommands({
          api: fakeApi,
          snapshot: missing,
          onOpenSettings: () => undefined,
        })
      )
    ).toContain(CommandIds.extensionsInitializeUserRoot());
  });

  test("Initialize User Root command calls initializeUserRoot", async () => {
    const initializeUserRoot = mock(() => Promise.resolve());
    const api = {
      extensions: {
        initializeUserRoot,
      },
    } as unknown as Parameters<typeof buildExtensionsPaletteCommands>[0]["api"];
    const missing = makeSnapshot({
      roots: [makeRoot({ kind: "user-global", rootExists: false })],
    });
    const command = buildExtensionsPaletteCommands({
      api,
      snapshot: missing,
      onOpenSettings: () => undefined,
    }).find((c) => c.id === CommandIds.extensionsInitializeUserRoot());

    await command?.run();

    expect(initializeUserRoot).toHaveBeenCalled();
  });

  test("Review Pending only visible when at least one extension has drift", () => {
    const noDrift = makeSnapshot({
      permissions: {
        "vendor.demo": {
          effectivePermissions: [],
          pendingNew: [],
          contributions: [],
          driftStatus: "fresh",
          isStale: false,
        },
      },
    });
    expect(
      visibleIds(
        buildExtensionsPaletteCommands({
          api: fakeApi,
          snapshot: noDrift,
          onOpenSettings: () => undefined,
        })
      )
    ).not.toContain(CommandIds.extensionsReviewPending());

    const withDrift = makeSnapshot({
      permissions: {
        "vendor.demo": {
          effectivePermissions: [],
          pendingNew: ["secrets.read"],
          contributions: [],
          driftStatus: "permissions-changed",
          isStale: false,
        },
      },
    });
    expect(
      visibleIds(
        buildExtensionsPaletteCommands({
          api: fakeApi,
          snapshot: withDrift,
          onOpenSettings: () => undefined,
        })
      )
    ).toContain(CommandIds.extensionsReviewPending());
  });

  test("Review Pending command uses capability approval wording", () => {
    const withDrift = makeSnapshot({
      permissions: {
        "vendor.demo": {
          effectivePermissions: [],
          pendingNew: ["secrets.read"],
          contributions: [],
          driftStatus: "permissions-changed",
          isStale: false,
        },
      },
    });
    const command = buildExtensionsPaletteCommands({
      api: fakeApi,
      snapshot: withDrift,
      onOpenSettings: () => undefined,
    }).find((c) => c.id === CommandIds.extensionsReviewPending());

    expect(command?.title).toBe("Review Pending Extension Capabilities");
    expect(command?.subtitle).toBe(
      "Open Extensions settings and surface capability approval drift"
    );
    expect(command?.keywords).toContain("capabilities");
  });

  test("root path command copies the primary path", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const snapshot = makeSnapshot({
      roots: [makeRoot({ kind: "user-global", path: "/u/.mux/extensions" })],
    });
    const command = buildExtensionsPaletteCommands({
      api: fakeApi,
      snapshot,
      onOpenSettings: () => undefined,
    }).find((c) => c.id === CommandIds.extensionsShowRootPath());

    if (!command) throw new Error("Expected root path command");
    await command.run();

    expect(writeText).toHaveBeenCalledWith("/u/.mux/extensions");
  });
});
