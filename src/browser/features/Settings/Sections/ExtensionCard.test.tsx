import "../../../../../tests/ui/dom";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { z } from "zod";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type * as schemas from "@/common/orpc/schemas/extensionRegistry";
import { installDom } from "../../../../../tests/ui/dom";
import { ExtensionCard, StaleRecordCard, computeExtensionStatus } from "./ExtensionCard";

type DiscoveredExtension = z.infer<typeof schemas.DiscoveredExtensionSchema>;
type CalculatePermissionsResult = z.infer<typeof schemas.CalculatePermissionsResultSchema>;
type ExtensionDiagnostic = z.infer<typeof schemas.ExtensionDiagnosticSchema>;
type StaleRecord = z.infer<typeof schemas.StaleRecordSchema>;

function makeExtension(overrides: Partial<DiscoveredExtension> = {}): DiscoveredExtension {
  return {
    extensionId: "vendor.demo",
    rootId: "root-1",
    rootKind: "user-global",
    isCore: false,
    modulePath: "/path/to/pkg",
    manifest: {
      manifestVersion: 1,
      id: "vendor.demo",
      displayName: "Demo Extension",
      description: "A demo extension for testing",
      publisher: "Acme",
      homepage: "https://example.com",
      requestedPermissions: ["skill.register", "secrets.read"],
      contributions: [
        { type: "skills", id: "demo.skill", index: 0, descriptor: {} },
        { type: "panels", id: "demo.panel", index: 0, descriptor: {} },
      ],
    },
    contributions: [],
    diagnostics: [],
    enabled: true,
    granted: true,
    activated: true,
    ...overrides,
  };
}

function makePermissions(
  overrides: Partial<CalculatePermissionsResult> = {}
): CalculatePermissionsResult {
  return {
    effectivePermissions: ["skill.register", "secrets.read"],
    pendingNew: [],
    contributions: [
      { type: "skills", id: "demo.skill", available: true, missingPermissions: [] },
      { type: "panels", id: "demo.panel", available: true, missingPermissions: [] },
    ],
    driftStatus: null,
    isStale: false,
    ...overrides,
  };
}

function diag(overrides: Partial<ExtensionDiagnostic>): ExtensionDiagnostic {
  return {
    code: overrides.code ?? "extension.identity.conflict",
    severity: overrides.severity ?? "error",
    message: overrides.message ?? "Conflict detected",
    extensionId: overrides.extensionId,
    contributionRef: overrides.contributionRef,
    suggestedAction: overrides.suggestedAction,
    occurredAt: overrides.occurredAt ?? 0,
  };
}

const noopHandlers = {
  onReload: () => undefined,
  onEnable: () => undefined,
  onDisable: () => undefined,
  onGrant: () => undefined,
  onRevoke: () => undefined,
};

function renderCard(
  extension: DiscoveredExtension,
  permissions: CalculatePermissionsResult | null,
  inspectionOnly = false,
  handlers: Partial<typeof noopHandlers> = {}
) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <ExtensionCard
        extension={extension}
        permissions={permissions}
        inspectionOnly={inspectionOnly}
        {...{ ...noopHandlers, ...handlers }}
      />
    </ThemeProvider>
  );
}

describe("computeExtensionStatus", () => {
  test("conflict outranks every other status", () => {
    const ext = makeExtension({
      diagnostics: [diag({ code: "extension.identity.conflict" })],
      enabled: false,
    });
    expect(
      computeExtensionStatus({
        extension: ext,
        permissions: makePermissions({ driftStatus: "permissions-changed" }),
        inspectionOnly: true,
      })
    ).toBe("conflict");
  });

  test("contribution.identity.conflict also produces conflict status", () => {
    const ext = makeExtension({
      diagnostics: [diag({ code: "contribution.identity.conflict", severity: "warn" })],
    });
    expect(
      computeExtensionStatus({
        extension: ext,
        permissions: makePermissions(),
        inspectionOnly: false,
      })
    ).toBe("conflict");
  });

  test("permission drift produces pending-reapproval status", () => {
    expect(
      computeExtensionStatus({
        extension: makeExtension(),
        permissions: makePermissions({ driftStatus: "permissions-changed" }),
        inspectionOnly: false,
      })
    ).toBe("pending-reapproval");
  });

  test("aligned approval keeps the extension enabled", () => {
    expect(
      computeExtensionStatus({
        extension: makeExtension(),
        permissions: makePermissions({ driftStatus: null }),
        inspectionOnly: false,
      })
    ).toBe("enabled");
  });

  test("fresh pending permissions keep the normal enabled status", () => {
    expect(
      computeExtensionStatus({
        extension: makeExtension(),
        permissions: makePermissions({
          driftStatus: "fresh",
          effectivePermissions: [],
          pendingNew: ["secrets.read"],
        }),
        inspectionOnly: false,
      })
    ).toBe("enabled");
  });

  test("blocking error without conflict/drift produces blocked status", () => {
    const ext = makeExtension({
      diagnostics: [diag({ code: "manifest.invalid", severity: "error" })],
    });
    expect(
      computeExtensionStatus({
        extension: ext,
        permissions: makePermissions(),
        inspectionOnly: false,
      })
    ).toBe("blocked");
  });

  test("untrusted root produces inspection-only status when nothing higher applies", () => {
    expect(
      computeExtensionStatus({
        extension: makeExtension(),
        permissions: makePermissions(),
        inspectionOnly: true,
      })
    ).toBe("inspection-only");
  });

  test("happy path produces enabled status", () => {
    expect(
      computeExtensionStatus({
        extension: makeExtension(),
        permissions: makePermissions(),
        inspectionOnly: false,
      })
    ).toBe("enabled");
  });

  test("disabled extension without other signals produces disabled status", () => {
    expect(
      computeExtensionStatus({
        extension: makeExtension({ enabled: false }),
        permissions: makePermissions(),
        inspectionOnly: false,
      })
    ).toBe("disabled");
  });
});

describe("ExtensionCard", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("collapsed view shows display name, Extension Name, description, status pill, and chevron", () => {
    const view = renderCard(makeExtension(), makePermissions());
    expect(view.getByText("Demo Extension")).toBeTruthy();
    expect(view.getByText("vendor.demo")).toBeTruthy();
    expect(view.queryByText(/demo-extension@1.2.3/)).toBeNull();
    expect(view.getByText("A demo extension for testing")).toBeTruthy();
    // Pill renders ENABLED status
    expect(view.getByLabelText(/Status: Enabled/)).toBeTruthy();
  });

  test("renders Conflict pill when identity conflict diagnostic present", () => {
    const ext = makeExtension({
      diagnostics: [diag({ code: "extension.identity.conflict" })],
    });
    const view = renderCard(ext, makePermissions());
    expect(view.getByLabelText(/Status: Conflict/)).toBeTruthy();
  });

  test("renders Pending re-approval pill when driftStatus is non-fresh", () => {
    const view = renderCard(
      makeExtension(),
      makePermissions({ driftStatus: "permissions-changed" })
    );
    expect(view.getByLabelText(/Status: Pending re-approval/)).toBeTruthy();
  });

  test("renders Blocked pill when manifest invalid", () => {
    const ext = makeExtension({
      diagnostics: [diag({ code: "manifest.invalid", severity: "error" })],
    });
    const view = renderCard(ext, makePermissions());
    expect(view.getByLabelText(/Status: Blocked/)).toBeTruthy();
  });

  test("renders Inspection only pill when inspectionOnly flag set", () => {
    const view = renderCard(makeExtension(), makePermissions(), true);
    expect(view.getByLabelText(/Status: Inspection only/)).toBeTruthy();
  });

  test("expanded view shows identity, capabilities, contributions, diagnostics blocks", () => {
    const ext = makeExtension({
      diagnostics: [
        diag({ code: "contribution.invalid", severity: "warn", message: "bad descriptor" }),
      ],
    });
    const view = renderCard(ext, makePermissions());
    const collapseToggle = view.getByText("Demo Extension").closest("button");
    expect(collapseToggle).toBeTruthy();
    fireEvent.click(collapseToggle!);

    expect(view.getByText("Identity")).toBeTruthy();
    expect(view.getByText("Capabilities")).toBeTruthy();
    expect(view.queryByText("Permissions")).toBeNull();
    expect(view.getByText("Contributions")).toBeTruthy();
    expect(view.getByText("Diagnostics")).toBeTruthy();
    // Identity block shows the manifest id
    expect(view.getAllByText("vendor.demo").length).toBeGreaterThan(0);
    expect(view.getByText("Module Path")).toBeTruthy();
    // Diagnostic surfaces with code + message
    expect(view.getByText("contribution.invalid")).toBeTruthy();
    expect(view.getByText("bad descriptor")).toBeTruthy();
  });

  test("agents render as inspection-only contributions", () => {
    const extension = makeExtension({
      manifest: {
        ...makeExtension().manifest,
        contributions: [{ type: "agents", id: "demo-agent", index: 0, descriptor: {} }],
      },
    });
    const view = renderCard(
      extension,
      makePermissions({
        contributions: [
          { type: "agents", id: "demo-agent", available: true, missingPermissions: [] },
        ],
      })
    );
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    expect(view.getByText("Inspection only")).toBeTruthy();
    expect(view.queryByText("Available")).toBeNull();
  });

  test("contributions table flags conflict via contribution.identity.conflict ref", () => {
    const ext = makeExtension({
      diagnostics: [
        diag({
          code: "contribution.identity.conflict",
          severity: "warn",
          contributionRef: { type: "skills", id: "demo.skill" },
        }),
      ],
    });
    const view = renderCard(ext, makePermissions());
    const collapseToggle = view.getByText("Demo Extension").closest("button");
    fireEvent.click(collapseToggle!);
    // The table should render a Conflict cell for this contribution row.
    expect(view.getAllByText(/Conflict/i).length).toBeGreaterThanOrEqual(1);
  });

  test("registration capabilities are collapsed by default with explanation link", () => {
    const view = renderCard(makeExtension(), makePermissions());
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    // The button text still appears even when collapsed.
    expect(view.getByText(/Registration Capabilities/)).toBeTruthy();
    expect(view.getByText(/Effect Capabilities/)).toBeTruthy();
    // The explanation link is rendered.
    expect(view.getByText("Why?")).toBeTruthy();
  });

  test("Re-approve pending button appears when capability drift is detected", () => {
    const view = renderCard(
      makeExtension(),
      makePermissions({ driftStatus: "permissions-changed" })
    );
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    expect(view.getByLabelText("Re-approve pending capabilities")).toBeTruthy();
  });

  test("aligned approval keeps the revoke action", () => {
    const view = renderCard(makeExtension(), makePermissions({ driftStatus: null }));
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    expect(view.queryByLabelText("Re-approve pending capabilities")).toBeNull();
    expect(view.getByLabelText("Revoke approval")).toBeTruthy();
  });

  test("Approve button appears when no approval record exists yet", () => {
    const view = renderCard(
      makeExtension(),
      makePermissions({ driftStatus: "fresh", effectivePermissions: [], pendingNew: [] })
    );
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    expect(view.getByLabelText("Approve capabilities")).toBeTruthy();
  });

  test("Revoke button appears when approval record fully aligned", () => {
    const view = renderCard(makeExtension(), makePermissions({ driftStatus: null }));
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    expect(view.getByLabelText("Revoke approval")).toBeTruthy();
  });

  test("bundled extensions show policy-approved state instead of revoke", () => {
    const view = renderCard(
      makeExtension({ rootKind: "bundled" }),
      makePermissions({ driftStatus: null })
    );
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    expect(view.getByText("Policy-enabled")).toBeTruthy();
    expect(view.queryByLabelText("Disable extension")).toBeNull();
    expect(view.getByText("Policy-approved")).toBeTruthy();
    expect(view.queryByLabelText("Revoke approval")).toBeNull();
  });

  test("inspectionOnly disables every action button", () => {
    const view = renderCard(makeExtension(), makePermissions(), true);
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    expect((view.getByLabelText("Reload extension") as HTMLButtonElement).disabled).toBe(true);
    // Disable button rendered because extension.enabled === true.
    expect((view.getByLabelText("Disable extension") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByLabelText("Revoke approval") as HTMLButtonElement).disabled).toBe(true);
  });

  test("clicking Disable invokes onDisable with rootId/extensionId", () => {
    const onDisable = mock(() => undefined);
    const view = renderCard(makeExtension(), makePermissions(), false, { onDisable });
    fireEvent.click(view.getByText("Demo Extension").closest("button")!);
    fireEvent.click(view.getByLabelText("Disable extension"));
    expect(onDisable).toHaveBeenCalledWith("root-1", "vendor.demo");
  });
});

describe("StaleRecordCard", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders Stale Approval Record label and Forget/Keep actions", () => {
    const record: StaleRecord = {
      scope: "global",
      projectPath: undefined,
      extensionId: "vendor.gone",
      approval: {
        grantedPermissions: ["secrets.read"],
        requestedPermissionsHash: "deadbeef",
      },
      rootId: "stale-root",
    };
    const onForget = mock(() => undefined);
    const onKeep = mock(() => undefined);
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <StaleRecordCard record={record} onForget={onForget} onKeep={onKeep} />
      </ThemeProvider>
    );
    expect(view.getByText("vendor.gone")).toBeTruthy();
    expect(view.getByText(/Stale Approval Record/)).toBeTruthy();

    fireEvent.click(view.getByLabelText("Forget stale record"));
    expect(onForget).toHaveBeenCalledWith("stale-root", "vendor.gone");

    fireEvent.click(view.getByLabelText("Keep stale record"));
    expect(onKeep).toHaveBeenCalled();
  });
});
