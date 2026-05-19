import "../../../../../tests/ui/dom";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { z } from "zod";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import type * as schemas from "@/common/orpc/schemas/extensionRegistry";
import { installDom } from "../../../../../tests/ui/dom";
import { ConsentShortcutModal } from "./ConsentShortcutModal";

type DiscoveredExtension = z.infer<typeof schemas.DiscoveredExtensionSchema>;
type CalculatePermissionsResult = z.infer<typeof schemas.CalculatePermissionsResultSchema>;

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
      description: undefined,
      publisher: undefined,
      homepage: undefined,
      requestedPermissions: ["skill.register", "secrets.read", "process.spawn"],
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
    pendingNew: ["secrets.read", "process.spawn"],
    contributions: [],
    driftStatus: "fresh",
    isStale: false,
    ...overrides,
  };
}

function renderModal(props: Partial<React.ComponentProps<typeof ConsentShortcutModal>> = {}) {
  const onConfirm = mock(() => undefined);
  const onReviewIndividually = mock(() => undefined);
  const onClose = mock(() => undefined);

  const view = render(
    <ThemeProvider forcedTheme="dark">
      <ConsentShortcutModal
        isOpen
        extension={makeExtension()}
        permissions={makePermissions()}
        requiresTrustRoot={false}
        onConfirm={onConfirm}
        onReviewIndividually={onReviewIndividually}
        onClose={onClose}
        {...props}
      />
    </ThemeProvider>
  );
  return { view, onConfirm, onReviewIndividually, onClose };
}

describe("ConsentShortcutModal", () => {
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

  test("does not render when isOpen=false", () => {
    const { view } = renderModal({ isOpen: false });
    expect(view.queryByTestId("consent-shortcut-modal")).toBeNull();
  });

  test("does not render when extension is null", () => {
    const { view } = renderModal({ extension: null });
    expect(view.queryByTestId("consent-shortcut-modal")).toBeNull();
  });

  test("renders summary with display name and effect capabilities only", () => {
    const { view } = renderModal();
    expect(view.getByText(/Set up Demo Extension/)).toBeTruthy();
    expect(view.getByText("vendor.demo")).toBeTruthy();
    expect(view.queryByText(/demo-extension@1.2.3/)).toBeNull();
    // Effect capabilities appear (not the inferred .register one)
    expect(view.getByText("secrets.read")).toBeTruthy();
    expect(view.getByText("process.spawn")).toBeTruthy();
    // .register is mentioned via the registration capability summary line, not as an entry
    expect(view.queryByText("skill.register")).toBeNull();
    expect(view.getByText(/Plus 1 registration capability/)).toBeTruthy();
  });

  test("renders contributions list", () => {
    const { view } = renderModal();
    expect(view.getByText(/Contributions \(1\)/)).toBeTruthy();
    expect(view.getByText("demo.skill")).toBeTruthy();
  });

  test("only mentions Trust the project-local Extensions root when requiresTrustRoot is true", () => {
    const { view: a } = renderModal({ requiresTrustRoot: false });
    expect(a.queryByText(/Trust the project-local/i)).toBeNull();

    const { view: b } = renderModal({ requiresTrustRoot: true });
    expect(b.getByText(/Trust the project-local/i)).toBeTruthy();
  });

  test("Confirm button invokes onConfirm", () => {
    const { view, onConfirm } = renderModal();
    fireEvent.click(view.getByLabelText("Confirm consent shortcut"));
    expect(onConfirm).toHaveBeenCalled();
  });

  test("Review individually link invokes onReviewIndividually", () => {
    const { view, onReviewIndividually } = renderModal();
    fireEvent.click(view.getByTestId("consent-shortcut-review-individually"));
    expect(onReviewIndividually).toHaveBeenCalled();
  });

  test("Cancel button invokes onClose", () => {
    const { view, onClose } = renderModal();
    fireEvent.click(view.getByLabelText("Cancel consent"));
    expect(onClose).toHaveBeenCalled();
  });

  test("backdrop click invokes onClose", () => {
    const { view, onClose } = renderModal();
    fireEvent.click(view.getByLabelText("Close consent shortcut"));
    expect(onClose).toHaveBeenCalled();
  });
});
