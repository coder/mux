import { describe, expect, test } from "bun:test";

import { extensionPermissionKey } from "@/common/extensions/extensionPermissionKey";
import { hashRequestedPermissions } from "@/common/extensions/permissionCalculator";
import type { ApprovalRecord } from "@/common/extensions/globalExtensionState";
import type { ValidatedManifest } from "@/common/extensions/manifestValidator";
import type {
  DiscoveredExtension,
  ExtensionRootDescriptor,
  RootDiscoveryResult,
} from "@/node/extensions/extensionDiscoveryService";
import type { DiscoverFn } from "@/node/extensions/extensionRegistryService";
import { createTestExtensionRegistry } from "@/node/extensions/testExtensionRegistry";

import { formatSnapshotForDebug } from "./extensions";

const FROZEN_NOW = 1_700_000_000_000;

const SAMPLE_APPROVAL: ApprovalRecord = {
  grantedPermissions: ["skill.register"],
  requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
};

function makeManifest(
  id: string,
  contributions: ReadonlyArray<{ type: string; id: string }>
): ValidatedManifest {
  return {
    manifestVersion: 1,
    id,
    requestedPermissions: contributions.map((c) => `${c.type.replace(/s$/, "")}.register`),
    contributions: contributions.map((c, index) => ({
      type: c.type,
      id: c.id,
      index,
      descriptor: { descriptorVersion: 1, id: c.id },
    })),
  };
}

function makeExtension(opts: {
  extensionId: string;
  rootId: string;
  rootKind: ExtensionRootDescriptor["kind"];
  contributions?: ReadonlyArray<{ type: string; id: string }>;
}): DiscoveredExtension {
  const contributions = (opts.contributions ?? []).map((c, index) => ({
    type: c.type,
    id: c.id,
    index,
    activated: true,
  }));
  return {
    extensionId: opts.extensionId,
    rootId: opts.rootId,
    rootKind: opts.rootKind,
    isCore: false,
    modulePath: `/fake/${opts.extensionId}`,
    manifest: makeManifest(opts.extensionId, opts.contributions ?? []),
    contributions,
    diagnostics: [],
    enabled: true,
    granted: true,
    activated: true,
  };
}

function discoveryStub(rootResults: readonly RootDiscoveryResult[]): DiscoverFn {
  return (input) =>
    Promise.resolve({ generatedAt: input.now ?? FROZEN_NOW, roots: [...rootResults] });
}

describe("debug extensions — formatSnapshotForDebug", () => {
  test("cold state: no reload yet → snapshot is null", async () => {
    const env = await createTestExtensionRegistry({
      roots: () => [],
      now: () => FROZEN_NOW,
    });
    try {
      // No reload() call: this is the genuine cold-start state.
      const out = formatSnapshotForDebug(env.registry.getSnapshot());
      expect(out).toEqual({ generatedAt: null, filterRootId: null, snapshot: null });
    } finally {
      await env.cleanup();
    }
  });

  test("post-install: reload populates roots, extensions, contributions, permissions", async () => {
    const userGlobalRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user-global",
    };
    const env = await createTestExtensionRegistry({
      roots: () => [userGlobalRoot],
      discoverFn: discoveryStub([
        {
          rootId: "user-global",
          kind: "user-global",
          path: "/fake/user-global",
          trusted: true,
          rootExists: true,
          state: "ready",
          extensions: [
            makeExtension({
              extensionId: "author.skill",
              rootId: "user-global",
              rootKind: "user-global",
              contributions: [{ type: "skills", id: "demo" }],
            }),
          ],
          diagnostics: [],
        },
      ]),
      now: () => FROZEN_NOW,
    });
    try {
      await env.globalState.setApproval("author.skill", SAMPLE_APPROVAL);
      await env.registry.reload();
      const out = formatSnapshotForDebug(env.registry.getSnapshot());

      expect(out.generatedAt).toBe(FROZEN_NOW);
      expect(out.filterRootId).toBeNull();
      expect(out.snapshot).not.toBeNull();
      expect(out.snapshot!.roots).toHaveLength(1);
      const root = out.snapshot!.roots[0];
      expect(root.rootId).toBe("user-global");
      expect(root.state).toBe("ready");
      expect(root.extensions).toHaveLength(1);
      expect(root.extensions[0]).toMatchObject({
        extensionId: "author.skill",
      });
      expect(out.snapshot!.availableContributions).toHaveLength(1);
      expect(out.snapshot!.availableContributions[0]).toMatchObject({
        type: "skills",
        id: "demo",
        extensionId: "author.skill",
      });
      // Approval record content is included verbatim — approved capabilities
      // are diagnostic, not secret.
      const permEntry =
        out.snapshot!.permissions[extensionPermissionKey("user-global", "author.skill")];
      if (permEntry == null) throw new Error("missing permissions entry");
      expect(Array.isArray(permEntry.effectivePermissions)).toBe(true);
      expect(Array.isArray(permEntry.contributions)).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  test("post-failure: discovery yields a failed root surfaces state + diagnostics", async () => {
    const userGlobalRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user-global",
    };
    const env = await createTestExtensionRegistry({
      roots: () => [userGlobalRoot],
      discoverFn: discoveryStub([
        {
          rootId: "user-global",
          kind: "user-global",
          path: "/fake/user-global",
          trusted: true,
          rootExists: true,
          state: "failed",
          extensions: [],
          diagnostics: [
            {
              code: "root.discovery.timeout",
              severity: "error",
              message: "Discovery timed out",
              occurredAt: FROZEN_NOW,
            },
          ],
        },
      ]),
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      const out = formatSnapshotForDebug(env.registry.getSnapshot());

      expect(out.snapshot!.roots).toHaveLength(1);
      expect(out.snapshot!.roots[0].state).toBe("failed");
      expect(out.snapshot!.roots[0].diagnostics).toHaveLength(1);
      expect(out.snapshot!.roots[0].diagnostics[0]).toMatchObject({
        code: "root.discovery.timeout",
        severity: "error",
      });
      expect(out.snapshot!.roots[0].extensions).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });

  test("--root filter narrows to the matching root only", async () => {
    const userGlobalRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user-global",
    };
    const projectRoot: ExtensionRootDescriptor = {
      rootId: "project-local:/fake/proj",
      kind: "project-local",
      path: "/fake/proj/.mux/extensions",
      trusted: true,
    };
    const env = await createTestExtensionRegistry({
      roots: () => [userGlobalRoot, projectRoot],
      discoverFn: discoveryStub([
        {
          rootId: "user-global",
          kind: "user-global",
          path: "/fake/user-global",
          trusted: true,
          rootExists: true,
          state: "ready",
          extensions: [
            makeExtension({
              extensionId: "global.skill",
              rootId: "user-global",
              rootKind: "user-global",
              contributions: [{ type: "skills", id: "global-demo" }],
            }),
          ],
          diagnostics: [],
        },
        {
          rootId: "project-local:/fake/proj",
          kind: "project-local",
          path: "/fake/proj/.mux/extensions",
          trusted: true,
          rootExists: true,
          state: "ready",
          extensions: [
            makeExtension({
              extensionId: "local.skill",
              rootId: "project-local:/fake/proj",
              rootKind: "project-local",
              contributions: [{ type: "skills", id: "local-demo" }],
            }),
          ],
          diagnostics: [],
        },
      ]),
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      const out = formatSnapshotForDebug(env.registry.getSnapshot(), {
        rootId: "user-global",
      });

      expect(out.filterRootId).toBe("user-global");
      expect(out.snapshot!.roots).toHaveLength(1);
      expect(out.snapshot!.roots[0].rootId).toBe("user-global");
      expect(out.snapshot!.descriptors.every((d) => d.rootId === "user-global")).toBe(true);
      expect(out.snapshot!.availableContributions.every((c) => c.rootId === "user-global")).toBe(
        true
      );
      expect(Object.keys(out.snapshot!.permissions)).toEqual([
        extensionPermissionKey("user-global", "global.skill"),
      ]);
    } finally {
      await env.cleanup();
    }
  });

  test("--root filter on unknown rootId yields empty roots without crashing", () => {
    const out = formatSnapshotForDebug(
      {
        generatedAt: FROZEN_NOW,
        roots: [],
        availableContributions: [],
        resolverDiagnostics: [],
        descriptors: [],
        permissions: {},
        staleRecords: [],
      },
      { rootId: "nope" }
    );
    expect(out.filterRootId).toBe("nope");
    expect(out.snapshot!.roots).toEqual([]);
  });
});
