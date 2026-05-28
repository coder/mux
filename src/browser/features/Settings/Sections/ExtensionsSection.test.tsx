import "../../../../../tests/ui/dom";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type { z } from "zod";
import { installDom } from "../../../../../tests/ui/dom";
import type * as extensionRegistrySchemas from "@/common/orpc/schemas/extensionRegistry";

type RegistrySnapshot = z.infer<typeof extensionRegistrySchemas.RegistrySnapshotSchema>;
type RootDiscoveryResult = z.infer<typeof extensionRegistrySchemas.RootDiscoveryResultSchema>;
type DiscoveredExtension = z.infer<typeof extensionRegistrySchemas.DiscoveredExtensionSchema>;
type CalculatePermissionsResult = z.infer<
  typeof extensionRegistrySchemas.CalculatePermissionsResultSchema
>;

interface MockAPIClient {
  extensions: {
    list: () => Promise<RegistrySnapshot | null>;
    onChanged: (input: undefined, opts: { signal: AbortSignal }) => AsyncIterable<void>;
    initializeUserRoot: () => Promise<void>;
    reload: (input: { rootId?: string }) => Promise<void>;
    trustRoot: (input: { rootId: string }) => Promise<void>;
    untrustRoot: (input: { rootId: string }) => Promise<void>;
    enable: (input: { rootId: string; extensionId: string }) => Promise<void>;
    disable: (input: { rootId: string; extensionId: string }) => Promise<void>;
    approve: (input: { rootId: string; extensionId: string }) => Promise<void>;
    revokeApproval: (input: { rootId: string; extensionId: string }) => Promise<void>;
    forgetStale: (input: { rootId: string; extensionId: string }) => Promise<void>;
  };
}

let mockApi: MockAPIClient;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { ExtensionsSection } from "./ExtensionsSection";
import { getExtensionCardTestId } from "./ExtensionCard";
import { __setExtensionDiagnosticsLogSink } from "./extensionDiagnostics";

function neverIterator(): AsyncIterable<void> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<void>>(() => {
          // never resolves
        }),
    }),
  };
}

function makeRoot(overrides: Partial<RootDiscoveryResult>): RootDiscoveryResult {
  return {
    rootId: overrides.rootId ?? "root-id",
    kind: overrides.kind ?? "bundled",
    path: overrides.path ?? "/path/to/root",
    trusted: overrides.trusted ?? true,
    rootExists: overrides.rootExists ?? true,
    state: overrides.state ?? "ready",
    extensions: overrides.extensions ?? [],
    diagnostics: overrides.diagnostics ?? [],
  };
}

function makeSnapshot(roots: RootDiscoveryResult[]): RegistrySnapshot {
  return {
    generatedAt: 0,
    roots,
    availableContributions: [],
    resolverDiagnostics: [],
    descriptors: [],
    permissions: {},
    staleRecords: [],
  };
}

function makeExtension(overrides: Partial<DiscoveredExtension> = {}): DiscoveredExtension {
  return {
    extensionId: "vendor.demo",
    rootId: "user-root",
    rootKind: "user-global",
    isCore: false,
    modulePath: "/p",
    manifest: {
      manifestVersion: 1,
      id: "vendor.demo",
      displayName: "Demo Extension",
      description: undefined,
      publisher: undefined,
      homepage: undefined,
      requestedPermissions: ["secrets.read"],
      contributions: [{ type: "skills", id: "demo.skill", index: 0, descriptor: {} }],
    },
    contributions: [],
    diagnostics: [],
    enabled: false,
    granted: false,
    activated: false,
    ...overrides,
  };
}

function makePermissions(
  overrides: Partial<CalculatePermissionsResult> = {}
): CalculatePermissionsResult {
  return {
    effectivePermissions: [],
    pendingNew: [],
    contributions: [],
    driftStatus: "fresh",
    isStale: false,
    ...overrides,
  };
}

function setApi(
  snapshot: RegistrySnapshot | null,
  overrides: Partial<MockAPIClient["extensions"]> = {}
) {
  mockApi = {
    extensions: {
      list: mock(() => Promise.resolve(snapshot)),
      onChanged: mock((_input, _opts) => neverIterator()),
      initializeUserRoot: mock(() => Promise.resolve()),
      reload: mock(() => Promise.resolve()),
      trustRoot: mock(() => Promise.resolve()),
      untrustRoot: mock(() => Promise.resolve()),
      enable: mock(() => Promise.resolve()),
      disable: mock(() => Promise.resolve()),
      approve: mock(() => Promise.resolve()),
      revokeApproval: mock(() => Promise.resolve()),
      forgetStale: mock(() => Promise.resolve()),
      ...overrides,
    },
  };
}

function renderSection() {
  return render(
    <ThemeProvider forcedTheme="dark">
      <ExtensionsSection />
    </ThemeProvider>
  );
}

describe("ExtensionsSection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    __setExtensionDiagnosticsLogSink({
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    });
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    __setExtensionDiagnosticsLogSink(null);
  });

  test("renders header with platform-state line and aggregate counts", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ rootId: "bundled-root", kind: "bundled", path: "/bundled" }),
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          path: "/user",
          rootExists: true,
        }),
      ])
    );

    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText(/Platform state:/i)).toBeTruthy();
    });
    expect(view.getByText(/0 errors/i)).toBeTruthy();
    expect(view.getByText(/0 warnings/i)).toBeTruthy();
    expect(view.getByLabelText("Reload Extensions")).toBeTruthy();
  });

  test("subscribes before fetching the initial snapshot", async () => {
    const calls: string[] = [];
    setApi(makeSnapshot([]), {
      list: mock(() => {
        calls.push("list");
        return Promise.resolve(makeSnapshot([]));
      }),
      onChanged: mock((_input, _opts) => {
        calls.push("onChanged");
        return neverIterator();
      }),
    });

    renderSection();

    await waitFor(() => expect(mockApi.extensions.list).toHaveBeenCalled(), { timeout: 5_000 });
    expect(calls.slice(0, 2)).toEqual(["onChanged", "list"]);
  });

  test("user-global root not initialized: surfaces Initialize affordance", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ rootId: "bundled-root", kind: "bundled" }),
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          path: "/user",
          rootExists: false,
        }),
      ])
    );

    const view = renderSection();

    await waitFor(() => {
      const buttons = view.getAllByLabelText("Initialize User Extensions Root");
      // Both action-row button and inline empty-state button are rendered.
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("user-global root initialized but empty: shows module authoring hint and Reload affordance", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ rootId: "bundled-root", kind: "bundled" }),
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          path: "/user/extensions/local",
          rootExists: true,
        }),
      ])
    );

    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText(/mkdir -p \/user\/extensions\/local\/acme-review/)).toBeTruthy();
    });
    expect(view.queryByText(/bun add <package-name>/)).toBeNull();
    // Action-row "Reload Extensions" + empty-state "Reload" are both present.
    expect(view.getAllByLabelText(/Reload/i).length).toBeGreaterThanOrEqual(1);
  });

  test("project-local missing dir: subsection hidden entirely", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ rootId: "bundled-root", kind: "bundled" }),
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: true,
        }),
        makeRoot({
          rootId: "project-root",
          kind: "project-local",
          path: "/proj/.mux/extensions",
          rootExists: false,
          trusted: true,
        }),
      ])
    );

    const view = renderSection();

    await waitFor(() => {
      expect(view.getByTestId("root-subsection-bundled-root")).toBeTruthy();
    });
    expect(view.queryByTestId("root-subsection-project-root")).toBeNull();
  });

  test("lock-only project root states that extensions are declared but not discovered before trust", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ rootId: "bundled-root", kind: "bundled" }),
        makeRoot({
          rootId: "project-root",
          kind: "project-local",
          path: "/repo/.mux",
          rootExists: true,
          trusted: false,
        }),
      ])
    );

    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText(/declares extension sources/i)).toBeTruthy();
    });
    expect(view.getByText(/not fetched, parsed, or executed/i)).toBeTruthy();
  });

  test("project-local present + root untrusted: shows Trust this root header action", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ rootId: "bundled-root", kind: "bundled" }),
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: true,
        }),
        makeRoot({
          rootId: "project-root",
          kind: "project-local",
          path: "/proj/.mux/extensions",
          rootExists: true,
          trusted: false,
        }),
      ])
    );

    const view = renderSection();

    await waitFor(() => {
      expect(view.getByLabelText("Trust this root")).toBeTruthy();
    });
  });

  test("renders three roots in fixed order: Bundled → User-global → Project-local", async () => {
    setApi(
      makeSnapshot([
        makeRoot({
          rootId: "project-root",
          kind: "project-local",
          rootExists: true,
          trusted: true,
        }),
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: true,
        }),
        makeRoot({ rootId: "bundled-root", kind: "bundled" }),
      ])
    );

    const view = renderSection();

    const bundledHeader = await waitFor(() => view.getByText("Bundled"));
    const userHeader = view.getByText("User-global");
    const projectHeader = view.getByText("Project-local");

    const headers = [bundledHeader, userHeader, projectHeader];
    for (let i = 1; i < headers.length; i++) {
      const prev = headers[i - 1];
      const curr = headers[i];
      // DOCUMENT_POSITION_FOLLOWING (4) means `prev` precedes `curr` in document order.
      const position = prev.compareDocumentPosition(curr);
      expect(position & 4).toBe(4);
    }
  });

  test("renders every project-local root returned by the snapshot", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ kind: "bundled", rootId: "bundled", extensions: [] }),
        makeRoot({ kind: "user-global", rootId: "user-global", extensions: [] }),
        makeRoot({
          kind: "project-local",
          rootId: "project-local:/repo-a",
          path: "/repo-a/.mux/extensions",
          extensions: [],
        }),
        makeRoot({
          kind: "project-local",
          rootId: "project-local:/repo-b",
          path: "/repo-b/.mux/extensions",
          extensions: [],
        }),
      ])
    );

    const view = renderSection();
    await waitFor(() =>
      expect(view.getByTestId("root-subsection-project-local:/repo-a")).toBeTruthy()
    );
    expect(view.getByTestId("root-subsection-project-local:/repo-b")).toBeTruthy();
  });

  test("renders every user-global root returned by the snapshot", async () => {
    const localExtension = makeExtension({
      rootId: "user-global",
      extensionId: "local-review",
      manifest: {
        ...makeExtension().manifest,
        id: "local-review",
        displayName: "Local Review",
      },
    });
    const fetchedExtension = makeExtension({
      rootId: "user-global-fetched",
      extensionId: "fetched-review",
      manifest: {
        ...makeExtension().manifest,
        id: "fetched-review",
        displayName: "Fetched Review",
      },
    });
    setApi(
      makeSnapshot([
        makeRoot({ kind: "bundled", rootId: "bundled", extensions: [] }),
        makeRoot({ kind: "user-global", rootId: "user-global", extensions: [localExtension] }),
        makeRoot({
          kind: "user-global",
          rootId: "user-global-fetched",
          extensions: [fetchedExtension],
        }),
      ])
    );

    const view = renderSection();
    await waitFor(() => expect(view.getByText("Local Review")).toBeTruthy());

    expect(view.getByTestId("root-subsection-user-global")).toBeTruthy();
    expect(view.getByTestId("root-subsection-user-global-fetched")).toBeTruthy();
    expect(view.getByText("Fetched Review")).toBeTruthy();
  });

  test("Quick Setup opens Consent Shortcut Modal with extension summary", async () => {
    const ext = makeExtension({ enabled: false });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: "fresh" }) };
    setApi(snapshot);

    const view = renderSection();

    const collapseToggle = await waitFor(() => view.getByText("Demo Extension").closest("button"));
    fireEvent.click(collapseToggle!);

    fireEvent.click(view.getByLabelText("Quick setup with consent shortcut"));

    expect(view.getByTestId("consent-shortcut-modal")).toBeTruthy();
    expect(view.getByText(/Set up Demo Extension/)).toBeTruthy();
    // The card uses a user-global root → the modal must NOT mention trust root.
    expect(view.queryByText(/Trust the project-local/i)).toBeNull();
  });

  test("Quick Setup clears stale errors on retry", async () => {
    const ext = makeExtension({ enabled: false });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: "fresh" }) };
    setApi(snapshot);
    let attempts = 0;
    mockApi.extensions.approve = mock(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("approval failed")) : Promise.resolve();
    });

    const view = renderSection();

    const collapseToggle = await waitFor(() => view.getByText("Demo Extension").closest("button"));
    fireEvent.click(collapseToggle!);
    fireEvent.click(view.getByLabelText("Quick setup with consent shortcut"));
    fireEvent.click(view.getByLabelText("Confirm consent shortcut"));
    await waitFor(() => expect(view.getByText("approval failed")).toBeTruthy());

    fireEvent.click(view.getByLabelText("Quick setup with consent shortcut"));
    fireEvent.click(view.getByLabelText("Confirm consent shortcut"));
    await waitFor(() => expect(mockApi.extensions.approve).toHaveBeenCalledTimes(2));
    expect(view.queryByText("approval failed")).toBeNull();
  });

  test("Quick Setup rolls back enable when approval fails", async () => {
    const ext = makeExtension({ enabled: false });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: "fresh" }) };
    setApi(snapshot);
    mockApi.extensions.approve = mock(() => Promise.reject(new Error("approval failed")));

    const view = renderSection();

    const collapseToggle = await waitFor(() => view.getByText("Demo Extension").closest("button"));
    fireEvent.click(collapseToggle!);
    fireEvent.click(view.getByLabelText("Quick setup with consent shortcut"));
    fireEvent.click(view.getByLabelText("Confirm consent shortcut"));

    await waitFor(() => {
      expect(mockApi.extensions.disable).toHaveBeenCalledWith({
        rootId: ext.rootId,
        extensionId: ext.extensionId,
      });
    });
  });

  test("Quick Setup does not untrust project root when approval rollback follows trust", async () => {
    const ext = makeExtension({
      rootId: "project-root",
      rootKind: "project-local",
      enabled: false,
    });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "project-root",
        kind: "project-local",
        path: "/proj/.mux/extensions",
        rootExists: true,
        trusted: false,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: "fresh" }) };
    setApi(snapshot);
    mockApi.extensions.approve = mock(() => Promise.reject(new Error("approval failed")));

    const view = renderSection();

    const collapseToggle = await waitFor(() => view.getByText("Demo Extension").closest("button"));
    fireEvent.click(collapseToggle!);
    fireEvent.click(view.getByLabelText("Quick setup with consent shortcut"));
    fireEvent.click(view.getByLabelText("Confirm consent shortcut"));

    await waitFor(() => {
      expect(mockApi.extensions.trustRoot).toHaveBeenCalledWith({ rootId: "project-root" });
      expect(mockApi.extensions.disable).toHaveBeenCalledWith({
        rootId: "project-root",
        extensionId: ext.extensionId,
      });
    });
    expect(mockApi.extensions.untrustRoot).not.toHaveBeenCalled();
  });

  test("Review individually closes modal and forces card expansion", async () => {
    const ext = makeExtension();
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: "fresh" }) };
    setApi(snapshot);

    const view = renderSection();

    const collapseToggle = await waitFor(() => view.getByText("Demo Extension").closest("button"));
    fireEvent.click(collapseToggle!);
    fireEvent.click(view.getByLabelText("Quick setup with consent shortcut"));
    expect(view.getByTestId("consent-shortcut-modal")).toBeTruthy();

    fireEvent.click(view.getByTestId("consent-shortcut-review-individually"));
    expect(view.queryByTestId("consent-shortcut-modal")).toBeNull();
    // Granular flow: per-card approval button is now visible (card stays expanded).
    expect(view.getByLabelText("Approve capabilities")).toBeTruthy();
  });

  test("drift surfaces as Pending re-approval pill without opening any modal", async () => {
    const ext = makeExtension({ enabled: true });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = {
      [ext.extensionId]: makePermissions({
        driftStatus: "permissions-changed",
        effectivePermissions: ["secrets.read"],
      }),
    };
    setApi(snapshot);

    const view = renderSection();

    await waitFor(() => view.getByText("Demo Extension"));
    expect(view.getByLabelText(/Status: Pending re-approval/)).toBeTruthy();
    // No Consent Shortcut Modal appears just because of drift.
    expect(view.queryByTestId("consent-shortcut-modal")).toBeNull();
  });

  test("Disable button opens destructive confirm dialog (does not directly disable)", async () => {
    const ext = makeExtension({ enabled: true });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: null }) };
    setApi(snapshot);

    const view = renderSection();

    const collapseToggle = await waitFor(() => view.getByText("Demo Extension").closest("button"));
    fireEvent.click(collapseToggle!);
    fireEvent.click(view.getByLabelText("Disable extension"));
    expect(view.getByTestId("destructive-confirm-dialog")).toBeTruthy();
    expect(view.getByText(/Disable Demo Extension/i)).toBeTruthy();
    // Disable IPC must NOT have been called yet — confirmation gates it.
    expect(mockApi.extensions.disable).not.toHaveBeenCalled();
  });

  test("project-local trusted: shows Untrust this root header button and confirms before untrusting", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ rootId: "bundled-root", kind: "bundled" }),
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: true,
        }),
        makeRoot({
          rootId: "project-root",
          kind: "project-local",
          path: "/proj/.mux/extensions",
          rootExists: true,
          trusted: true,
        }),
      ])
    );

    const view = renderSection();
    await waitFor(() => view.getByLabelText("Untrust this root"));
    fireEvent.click(view.getByLabelText("Untrust this root"));
    expect(view.getByTestId("destructive-confirm-dialog")).toBeTruthy();
    expect(view.getByText(/Untrust this Extensions root/)).toBeTruthy();
    expect(mockApi.extensions.untrustRoot).not.toHaveBeenCalled();
  });

  test("Shift+? opens the keyboard cheat sheet", async () => {
    setApi(
      makeSnapshot([
        makeRoot({ rootId: "bundled-root", kind: "bundled" }),
        makeRoot({ rootId: "user-root", kind: "user-global", rootExists: true }),
      ])
    );
    const view = renderSection();

    await waitFor(() => view.getByText(/Platform state:/i));
    expect(view.queryByTestId("extensions-cheatsheet-modal")).toBeNull();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(view.getByTestId("extensions-cheatsheet-modal")).toBeTruthy();
  });

  test("R triggers a global reload (no rootId)", async () => {
    setApi(
      makeSnapshot([makeRoot({ rootId: "user-root", kind: "user-global", rootExists: true })])
    );
    const view = renderSection();
    await waitFor(() => view.getByText(/Platform state:/i));

    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => {
      // initial mount calls list(); the section's reload triggers extensions.reload({}).
      expect(mockApi.extensions.reload).toHaveBeenCalledWith({});
    });
  });

  test("J focuses the first extension card; K wraps to first when at start", async () => {
    const ext = makeExtension({ enabled: false });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: "fresh" }) };
    setApi(snapshot);

    const view = renderSection();
    await waitFor(() => view.getByText("Demo Extension"));

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      expect(view.getByTestId(getExtensionCardTestId(ext)).getAttribute("data-focused")).toBe(
        "true"
      );
    });
  });

  test("J focuses duplicate extension IDs one card at a time", async () => {
    const first = makeExtension({
      rootId: "bundled-root",
      rootKind: "bundled",
    });
    const second = makeExtension({
      rootId: "user-root",
      rootKind: "user-global",
    });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "bundled-root",
        kind: "bundled",
        rootExists: true,
        extensions: [first],
      }),
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [second],
      }),
    ]);
    setApi(snapshot);

    const view = renderSection();
    await waitFor(() => expect(view.getAllByText("Demo Extension")).toHaveLength(2));

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      expect(view.getByTestId(getExtensionCardTestId(first)).getAttribute("data-focused")).toBe(
        "true"
      );
      expect(
        view.getByTestId(getExtensionCardTestId(second)).getAttribute("data-focused")
      ).toBeNull();
    });

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      expect(
        view.getByTestId(getExtensionCardTestId(first)).getAttribute("data-focused")
      ).toBeNull();
      expect(view.getByTestId(getExtensionCardTestId(second)).getAttribute("data-focused")).toBe(
        "true"
      );
    });
  });

  test("Enter on focused card toggles its expansion", async () => {
    const ext = makeExtension({ enabled: false });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: "fresh" }) };
    setApi(snapshot);

    const view = renderSection();
    await waitFor(() => view.getByText("Demo Extension"));

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() =>
      expect(view.getByTestId(getExtensionCardTestId(ext)).getAttribute("data-focused")).toBe(
        "true"
      )
    );
    expect(view.queryByText(/Identity/i)).toBeNull();
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => view.getByText(/Identity/i));
  });

  test("E on focused disabled extension calls enable()", async () => {
    const ext = makeExtension({ enabled: false });
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "user-root",
        kind: "user-global",
        rootExists: true,
        extensions: [ext],
      }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: "fresh" }) };
    setApi(snapshot);

    const view = renderSection();
    await waitFor(() => view.getByText("Demo Extension"));
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() =>
      expect(view.getByTestId(getExtensionCardTestId(ext)).getAttribute("data-focused")).toBe(
        "true"
      )
    );
    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() => {
      expect(mockApi.extensions.enable).toHaveBeenCalledWith({
        rootId: "user-root",
        extensionId: ext.extensionId,
      });
    });
  });

  test("shortcuts ignore keystrokes originating in editable elements", async () => {
    setApi(
      makeSnapshot([makeRoot({ rootId: "user-root", kind: "user-global", rootExists: true })])
    );
    const view = renderSection();
    await waitFor(() => view.getByText(/Platform state:/i));

    // The initial mount calls list(); reload() should not be called yet.
    expect(mockApi.extensions.reload).not.toHaveBeenCalled();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "r" });
    fireEvent.keyDown(input, { key: "?", shiftKey: true });
    expect(view.queryByTestId("extensions-cheatsheet-modal")).toBeNull();
    expect(mockApi.extensions.reload).not.toHaveBeenCalled();
    input.remove();
  });

  test("T trusts the project-local root when it exists and is untrusted", async () => {
    setApi(
      makeSnapshot([
        makeRoot({
          rootId: "project-root",
          kind: "project-local",
          path: "/proj/.mux/extensions",
          rootExists: true,
          trusted: false,
        }),
      ])
    );
    const view = renderSection();
    await waitFor(() => view.getByLabelText("Trust this root"));
    fireEvent.keyDown(window, { key: "t" });
    await waitFor(() => {
      expect(mockApi.extensions.trustRoot).toHaveBeenCalledWith({ rootId: "project-root" });
    });
  });

  test("RootFailure: shows Failed pill and Retry button when root.state === 'failed'", async () => {
    setApi(
      makeSnapshot([
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          path: "/user",
          rootExists: true,
          state: "failed",
          diagnostics: [
            {
              code: "root.discovery.timeout",
              severity: "error",
              message: "discovery timed out",
              occurredAt: 0,
            },
          ],
        }),
      ])
    );

    const view = renderSection();
    await waitFor(() => view.getByTestId("root-failed-user-global"));
    const retry = view.getByTestId("root-retry-user-global");
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => {
      expect(mockApi.extensions.reload).toHaveBeenCalledWith({ rootId: "user-root" });
    });
  });

  test("RootFailure: root subsection renders the diagnostic at error severity", async () => {
    setApi(
      makeSnapshot([
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          path: "/user",
          rootExists: true,
          state: "failed",
          diagnostics: [
            {
              code: "root.discovery.timeout",
              severity: "error",
              message: "discovery timed out",
              occurredAt: 0,
            },
          ],
        }),
      ])
    );

    const view = renderSection();
    const list = await waitFor(() => view.getByTestId("root-diagnostics-user-global"));
    const item = list.querySelector('[data-diagnostic-code="root.discovery.timeout"]');
    expect(item).toBeTruthy();
    expect(item?.getAttribute("data-diagnostic-severity")).toBe("error");
  });

  test("ExtensionInvalid: blocking manifest error mirrors into root subsection diagnostics", async () => {
    const ext = makeExtension({
      enabled: false,
      diagnostics: [
        {
          code: "manifest.invalid",
          severity: "error",
          message: "manifest schema failed",
          occurredAt: 0,
        },
      ],
    });
    setApi(
      makeSnapshot([
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: true,
          extensions: [ext],
        }),
      ])
    );

    const view = renderSection();
    const list = await waitFor(() => view.getByTestId("root-diagnostics-user-global"));
    expect(list.querySelector('[data-diagnostic-code="manifest.invalid"]')).toBeTruthy();
    // Header tally still counts this.
    expect(view.getByText(/1 error\b/i)).toBeTruthy();
  });

  test("IdentityConflict: surfaces in root subsection at error severity", async () => {
    const ext = makeExtension({
      enabled: false,
      diagnostics: [
        {
          code: "extension.identity.conflict",
          severity: "error",
          message: "duplicate Extension identity",
          occurredAt: 0,
        },
      ],
    });
    setApi(
      makeSnapshot([
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: true,
          extensions: [ext],
        }),
      ])
    );

    const view = renderSection();
    const list = await waitFor(() => view.getByTestId("root-diagnostics-user-global"));
    const item = list.querySelector('[data-diagnostic-code="extension.identity.conflict"]');
    expect(item).toBeTruthy();
    expect(item?.getAttribute("data-diagnostic-severity")).toBe("error");
  });

  test("resolver diagnostics only attach to the owning root card", async () => {
    const userExt = makeExtension({ rootId: "user-root", rootKind: "user-global" });
    const projectExt = makeExtension({ rootId: "project-root", rootKind: "project-local" });
    const snapshot = makeSnapshot([
      makeRoot({ rootId: "user-root", kind: "user-global", extensions: [userExt] }),
      makeRoot({ rootId: "project-root", kind: "project-local", extensions: [projectExt] }),
    ]);
    snapshot.permissions = {
      [userExt.extensionId]: makePermissions({ driftStatus: null }),
      [`${projectExt.rootId}\0${projectExt.extensionId}`]: makePermissions({ driftStatus: null }),
    };
    snapshot.resolverDiagnostics = [
      {
        code: "extension.identity.conflict",
        severity: "error",
        message: "user-global conflict",
        rootId: userExt.rootId,
        extensionId: userExt.extensionId,
        occurredAt: 0,
      },
    ];
    setApi(snapshot);

    const view = renderSection();
    await waitFor(() => view.getAllByText("Demo Extension"));

    expect(
      view.getByTestId(getExtensionCardTestId(userExt)).querySelector('[data-status="conflict"]')
    ).toBeTruthy();
    expect(
      view.getByTestId(getExtensionCardTestId(projectExt)).querySelector('[data-status="conflict"]')
    ).toBeNull();
  });

  test("resolver conflicts feed extension card status", async () => {
    const ext = makeExtension({ enabled: true, granted: true });
    const snapshot = makeSnapshot([
      makeRoot({ kind: "user-global", rootId: "user-root", extensions: [ext] }),
    ]);
    snapshot.permissions = { [ext.extensionId]: makePermissions({ driftStatus: null }) };
    snapshot.resolverDiagnostics = [
      {
        code: "contribution.identity.conflict",
        severity: "warn",
        message: "Contribution conflict",
        extensionId: ext.extensionId,
        contributionRef: { type: "skills", id: "demo.skill" },
        occurredAt: 0,
      },
    ];
    setApi(snapshot);

    const view = renderSection();
    await waitFor(() => expect(view.getByText("Conflict")).toBeTruthy());
    fireEvent.click(view.getByText("Demo Extension"));
    expect(view.getByText("contribution.identity.conflict")).toBeTruthy();
  });

  test("ContributionInvalid: stays on the card at warn severity (not mirrored on root)", async () => {
    const ext = makeExtension({
      enabled: true,
      diagnostics: [
        {
          code: "contribution.invalid",
          severity: "warn",
          message: "bad contribution",
          contributionRef: { type: "skills", id: "demo.skill" },
          occurredAt: 0,
        },
      ],
    });
    setApi(
      makeSnapshot([
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: true,
          extensions: [ext],
        }),
      ])
    );

    const view = renderSection();
    await waitFor(() => view.getByText("Demo Extension"));
    // Root subsection diagnostics should NOT include the contribution-invalid code.
    const rootList = view.queryByTestId("root-diagnostics-user-global");
    if (rootList) {
      expect(rootList.querySelector('[data-diagnostic-code="contribution.invalid"]')).toBeNull();
    }
    // Header tally still counts the warning.
    expect(view.getByText(/1 warning\b/i)).toBeTruthy();
  });

  test("ContributionConflict: stays on the card at warn severity", async () => {
    const ext = makeExtension({
      enabled: true,
      diagnostics: [
        {
          code: "contribution.identity.conflict",
          severity: "warn",
          message: "duplicate contribution id",
          contributionRef: { type: "skills", id: "demo.skill" },
          occurredAt: 0,
        },
      ],
    });
    setApi(
      makeSnapshot([
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: true,
          extensions: [ext],
        }),
      ])
    );

    const view = renderSection();
    await waitFor(() => view.getByText("Demo Extension"));
    const rootList = view.queryByTestId("root-diagnostics-user-global");
    if (rootList) {
      expect(
        rootList.querySelector('[data-diagnostic-code="contribution.identity.conflict"]')
      ).toBeNull();
    }
  });

  test("aggregates errors and warnings across roots and resolver diagnostics", async () => {
    const snapshot = makeSnapshot([
      makeRoot({
        rootId: "bundled-root",
        kind: "bundled",
        diagnostics: [
          {
            code: "x",
            severity: "error",
            message: "boom",
            occurredAt: 0,
          },
        ],
        extensions: [
          {
            extensionId: "vendor.foo",
            rootId: "bundled-root",
            rootKind: "bundled",
            isCore: false,
            modulePath: "/p",
            manifest: {
              manifestVersion: 1,
              id: "vendor.foo",
              displayName: undefined,
              description: undefined,
              publisher: undefined,
              homepage: undefined,
              requestedPermissions: [],
              contributions: [],
            },
            contributions: [],
            diagnostics: [
              {
                code: "y",
                severity: "warn",
                message: "minor",
                occurredAt: 0,
              },
            ],
            enabled: true,
            granted: true,
            activated: true,
          },
        ],
      }),
    ]);
    snapshot.resolverDiagnostics = [{ code: "z", severity: "info", message: "fyi", occurredAt: 0 }];
    setApi(snapshot);

    const view = renderSection();

    await waitFor(() => {
      expect(view.getByText(/1 error\b/i)).toBeTruthy();
    });
    // Spec: info diagnostics never appear in the header. Only error + warn counts.
    expect(view.getByText(/1 warning\b/i)).toBeTruthy();
  });
});
