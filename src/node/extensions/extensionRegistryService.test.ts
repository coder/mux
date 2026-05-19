import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { extensionPermissionKey } from "@/common/extensions/extensionPermissionKey";
import { hashRequestedPermissions } from "@/common/extensions/permissionCalculator";
import { ExtensionRegistry, type DiscoverFn } from "./extensionRegistryService";
import { createTestExtensionRegistry } from "./testExtensionRegistry";
import {
  discoverExtensions,
  type DiscoveredExtension,
  type ExtensionRootDescriptor,
  type RootDiscoveryResult,
} from "./extensionDiscoveryService";
import { staleProjectLocalRootId } from "./extensionRegistryService";
import { Config } from "@/node/config";
import { GlobalExtensionStateService } from "./globalExtensionStateService";
import {
  getProjectExtensionStateRoot,
  ProjectExtensionStateService,
} from "./projectExtensionStateService";
import type { ApprovalRecord } from "@/common/extensions/globalExtensionState";
import type { ValidatedManifest } from "@/common/extensions/manifestValidator";

const FROZEN_NOW = 1_700_000_000_000;

const SAMPLE_GRANT: ApprovalRecord = {
  grantedPermissions: ["skill.register"],
  requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
};

function makeManifest(
  id: string,
  contributions: Array<{ type: string; id: string }> = []
): ValidatedManifest {
  const inferred = Array.from(new Set(contributions.map((c) => `${singularOf(c.type)}.register`)));
  return {
    manifestVersion: 1,
    id,
    requestedPermissions: inferred,
    contributions: contributions.map((c, index) => ({
      type: c.type,
      id: c.id,
      index,
      // Body field is descriptor-shape-specific; skills/agents need it for
      // Activation Discovery + agentSkillsService merge. Other descriptor
      // types ignore it, so it's harmless in fixtures.
      descriptor: { descriptorVersion: 1, id: c.id, body: `${c.id}.md` },
    })),
  };
}

function singularOf(type: string): string {
  if (type.endsWith("s")) return type.slice(0, -1);
  return type;
}

function makeExtension(opts: {
  extensionId: string;
  rootId: string;
  rootKind: ExtensionRootDescriptor["kind"];
  isCore?: boolean;
  enabled?: boolean;
  granted?: boolean;
  activated?: boolean;
  contributions?: Array<{
    type: string;
    id: string;
    activated?: boolean;
    bodyPath?: string;
    bodyRealPath?: string;
  }>;
}): DiscoveredExtension {
  const contributions = (opts.contributions ?? []).map((c, index) => {
    const activated = c.activated ?? opts.activated ?? true;
    const bodyPath = c.bodyPath ?? `${c.id}.md`;
    return {
      type: c.type,
      id: c.id,
      index,
      bodyPath,
      bodyRealPath: activated
        ? (c.bodyRealPath ?? `/fake/${opts.extensionId}/${bodyPath}`)
        : undefined,
      activated,
    };
  });
  return {
    extensionId: opts.extensionId,
    rootId: opts.rootId,
    rootKind: opts.rootKind,
    isCore: opts.isCore ?? false,
    modulePath: `/fake/${opts.extensionId}`,
    manifest: makeManifest(
      opts.extensionId,
      (opts.contributions ?? []).map((c) => ({ type: c.type, id: c.id }))
    ),
    contributions,
    diagnostics: [],
    enabled: opts.enabled ?? true,
    granted: opts.granted ?? true,
    activated: opts.activated ?? true,
  };
}

function makeRoot(
  rootDesc: ExtensionRootDescriptor,
  extensions: DiscoveredExtension[],
  trusted = true
): RootDiscoveryResult {
  return {
    rootId: rootDesc.rootId,
    kind: rootDesc.kind,
    path: rootDesc.path,
    trusted,
    rootExists: true,
    state: "ready",
    extensions,
    diagnostics: [],
  };
}

function stubDiscoverFn(
  buildRoots: (input: { roots: readonly ExtensionRootDescriptor[] }) => RootDiscoveryResult[]
): DiscoverFn {
  return (input) =>
    Promise.resolve({ generatedAt: input.now ?? FROZEN_NOW, roots: buildRoots(input) });
}

describe("ExtensionRegistry — basic snapshot lifecycle", () => {
  let env: Awaited<ReturnType<typeof createTestExtensionRegistry>>;

  beforeEach(async () => {
    env = await createTestExtensionRegistry();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("getSnapshot() returns null before reload()", () => {
    expect(env.registry.getSnapshot()).toBeNull();
  });

  test("reload keeps Full Activation sessions alive until an extension deactivates", async () => {
    const root: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user-global",
    };
    const abortSession = mock(() => undefined);
    const disposeSession = mock(() => undefined);
    let reloadCount = 0;
    const discoverFn: DiscoverFn = (input) => {
      reloadCount++;
      const extensions =
        reloadCount === 1
          ? [
              makeExtension({
                extensionId: "author.skill",
                rootId: root.rootId,
                rootKind: root.kind,
                contributions: [{ type: "skills", id: "demo" }],
              }),
            ]
          : [];
      if (extensions.length > 0) {
        input.activationSessionSink?.({
          rootId: root.rootId,
          extensionId: "author.skill",
          session: { abort: abortSession, dispose: disposeSession },
        });
      }
      return Promise.resolve({
        generatedAt: input.now ?? FROZEN_NOW,
        roots: [makeRoot(root, extensions)],
      });
    };
    const env = await createTestExtensionRegistry({
      roots: () => [root],
      discoverFn,
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      expect(disposeSession).not.toHaveBeenCalled();

      await env.registry.reload();
      expect(disposeSession).toHaveBeenCalledTimes(1);
    } finally {
      await env.cleanup();
    }
  });

  test("reload still publishes the live snapshot when optional cache write fails", async () => {
    const root: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user-global",
    };
    const env = await createTestExtensionRegistry({
      roots: () => [root],
      withSnapshotCache: true,
      discoverFn: stubDiscoverFn(({ roots }) => [makeRoot(roots[0], [])]),
      now: () => FROZEN_NOW,
    });
    try {
      if (!env.snapshotCache) throw new Error("Expected snapshot cache");
      spyOn(env.snapshotCache, "write").mockRejectedValue(new Error("disk full"));
      let changed = false;
      env.registry.onChanged(() => {
        changed = true;
      });

      await env.registry.reload();

      expect(changed).toBe(true);
      expect(env.registry.getSnapshot()?.roots[0].rootId).toBe(root.rootId);
    } finally {
      await env.cleanup();
    }
  });

  test("reload surfaces malformed global extension state diagnostics on the user-global root", async () => {
    const root: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user-global",
    };
    const env = await createTestExtensionRegistry({
      roots: () => [root],
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(roots[0], [
          makeExtension({
            extensionId: "author.skill",
            rootId: root.rootId,
            rootKind: root.kind,
            contributions: [{ type: "skills", id: "demo" }],
          }),
        ]),
      ]),
      now: () => FROZEN_NOW,
    });
    try {
      await fsp.writeFile(
        path.join(env.tempDir, "config.json"),
        JSON.stringify({
          extensions: {
            schemaVersion: 1,
            extensions: { "author.skill": { enabled: "broken" } },
          },
        }),
        "utf-8"
      );

      await env.registry.reload();

      const diagnostic = env.registry
        .getSnapshot()
        ?.roots[0].diagnostics.find((d) => d.code === "extension.state.record.invalid");
      expect(diagnostic).toMatchObject({
        rootId: root.rootId,
        extensionId: "author.skill",
      });
    } finally {
      await env.cleanup();
    }
  });

  test("reload surfaces malformed project-local extension state diagnostics on the project root", async () => {
    const projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), "mux-ext-state-diag-project-"));
    const root: ExtensionRootDescriptor = {
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: projectPath,
      trusted: true,
    };
    const env = await createTestExtensionRegistry({
      roots: () => [root],
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(roots[0], [
          makeExtension({
            extensionId: "author.skill",
            rootId: root.rootId,
            rootKind: root.kind,
            contributions: [{ type: "skills", id: "demo" }],
          }),
        ]),
      ]),
      now: () => FROZEN_NOW,
    });
    try {
      const stateFilePath = env.projectState.filePathFor(projectPath);
      await fsp.mkdir(path.dirname(stateFilePath), { recursive: true });
      await fsp.writeFile(
        stateFilePath,
        JSON.stringify({
          schemaVersion: 1,
          rootTrusted: true,
          extensions: { "author.skill": { enabled: "broken" } },
        }),
        "utf-8"
      );

      await env.registry.reload();

      const diagnostic = env.registry
        .getSnapshot()
        ?.roots[0].diagnostics.find((d) => d.code === "extension.state.record.invalid");
      expect(diagnostic).toMatchObject({
        rootId: root.rootId,
        extensionId: "author.skill",
      });
    } finally {
      await env.cleanup();
      await fsp.rm(projectPath, { recursive: true, force: true });
    }
  });

  test("getContributions() returns [] before reload()", () => {
    expect(env.registry.getContributions("skills")).toEqual([]);
  });

  test("reload() with no roots produces an empty snapshot and emits onChanged", async () => {
    let fired = 0;
    env.registry.onChanged(() => {
      fired += 1;
    });
    await env.registry.reload();
    const snap = env.registry.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.roots).toEqual([]);
    expect(snap!.availableContributions).toEqual([]);
    expect(snap!.descriptors).toEqual([]);
    expect(fired).toBe(1);
  });
});

describe("ExtensionRegistry — capability vs inspection paths", () => {
  let env: Awaited<ReturnType<typeof createTestExtensionRegistry>>;
  const bundledRoot: ExtensionRootDescriptor = {
    rootId: "bundled",
    kind: "bundled",
    path: "/fake/bundled",
    isCore: true,
  };

  beforeEach(async () => {
    env = await createTestExtensionRegistry({
      roots: () => [bundledRoot],
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(roots[0], [
          makeExtension({
            extensionId: "mux.platformdemo",
            rootId: "bundled",
            rootKind: "bundled",
            isCore: true,
            granted: true,
            activated: true,
            contributions: [{ type: "skills", id: "demo", activated: true }],
          }),
        ]),
      ]),
      now: () => FROZEN_NOW,
    });
    // Seed grant so calculator emits effective permission for skill.register.
    await env.globalState.setApproval("mux-platform-demo", {
      grantedPermissions: ["skill.register"],
      requestedPermissionsHash: "abc",
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("getContributions returns the resolved contribution after reload", async () => {
    await env.registry.reload();
    const contribs = env.registry.getContributions("skills");
    expect(contribs).toHaveLength(1);
    expect(contribs[0]).toMatchObject({
      type: "skills",
      id: "demo",
      extensionId: "mux.platformdemo",
      rootKind: "bundled",
    });
  });

  test("getDescriptors mirrors the same contribution as available=true", async () => {
    await env.registry.reload();
    const descs = env.registry.getDescriptors("skills");
    expect(descs).toHaveLength(1);
    expect(descs[0]).toMatchObject({
      type: "skills",
      id: "demo",
      extensionId: "mux.platformdemo",
      available: true,
      unavailableReasons: [],
    });
  });

  test("agents remain inspection-only until an agent consumer is wired", async () => {
    const env = await createTestExtensionRegistry({
      roots: () => [{ rootId: "user-global", kind: "user-global", path: "/fake/user-global" }],
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(roots[0], [
          makeExtension({
            extensionId: "author.agent",
            rootId: "user-global",
            rootKind: "user-global",
            contributions: [{ type: "agents", id: "helper" }],
          }),
        ]),
      ]),
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      await env.registry.setEnabled(
        { kind: "global", rootId: "user-global", rootKind: "user-global" },
        "author.agent",
        true
      );
      await env.registry.setApproval(
        { kind: "global", rootId: "user-global", rootKind: "user-global" },
        "author.agent"
      );

      expect(env.registry.getContributions("agents")).toEqual([]);
      expect(env.registry.getDescriptors("agents")[0]?.unavailableReasons).toContain(
        "inspection-only"
      );
    } finally {
      await env.cleanup();
    }
  });

  test("getContributions ignores unrelated types", async () => {
    await env.registry.reload();
    expect(env.registry.getContributions("agents")).toEqual([]);
  });
});

// Bundled Extensions are policy-granted, not user-consented. A fresh-install
// Demo Extension must be available with no manual grant.
describe("ExtensionRegistry — bundled policy auto-grant", () => {
  let env: Awaited<ReturnType<typeof createTestExtensionRegistry>>;
  const bundledRoot: ExtensionRootDescriptor = {
    rootId: "bundled",
    kind: "bundled",
    path: "/fake/bundled",
    isCore: true,
  };

  beforeEach(async () => {
    env = await createTestExtensionRegistry({
      roots: () => [bundledRoot],
      // Discovery is exercised through the real production gate so the
      // `granted` field reflects what the live runReload() composition sees,
      // not a stub that bypasses it.
      discoverFn: (input) => {
        const ctx = {
          rootId: bundledRoot.rootId,
          rootKind: bundledRoot.kind,
          extensionId: "mux.platformdemo",
          isBundled: true,
        };
        const enabled = input.state?.isEnabled?.(ctx) ?? true;
        const granted = input.state?.getApprovalRecord?.(ctx) !== undefined || ctx.isBundled;
        const activated = enabled && granted;
        return {
          generatedAt: input.now ?? FROZEN_NOW,
          roots: [
            makeRoot(bundledRoot, [
              makeExtension({
                extensionId: "mux.platformdemo",
                rootId: bundledRoot.rootId,
                rootKind: bundledRoot.kind,
                isCore: true,
                enabled,
                granted,
                activated,
                contributions: [{ type: "skills", id: "demo", activated }],
              }),
            ]),
          ],
        };
      },
      now: () => FROZEN_NOW,
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("contributes Available without any persisted approval record", async () => {
    await env.registry.reload();
    const contribs = env.registry.getContributions("skills");
    expect(contribs).toHaveLength(1);
    expect(contribs[0]).toMatchObject({ id: "demo", extensionId: "mux.platformdemo" });

    const snapshot = env.registry.getSnapshot();
    const perms = snapshot?.permissions[extensionPermissionKey("bundled", "mux.platformdemo")];
    // The synthesized policy grant must include the inferred registration
    // permission so the contribution clears `missing-permissions`, AND
    // driftStatus stays null — a synthesized grant always matches the
    // distribution it was synthesized from, so drift never accrues for
    // bundled Extensions across version bumps.
    expect(perms?.contributions[0]).toMatchObject({ available: true, missingPermissions: [] });
    expect(perms?.effectivePermissions).toContain("skill.register");
    expect(perms?.driftStatus).toBeNull();
    expect(perms?.pendingNew).toEqual([]);
  });

  test("setEnabled ignores bundled roots instead of writing user-global state", async () => {
    const extensionId = "author.skill";
    const env = await createTestExtensionRegistry({
      roots: () => [{ rootId: "bundled", kind: "bundled", path: "/fake/bundled" }],
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(roots[0], [
          makeExtension({
            extensionId,
            rootId: roots[0].rootId,
            rootKind: roots[0].kind,
            contributions: [{ type: "skills", id: "demo" }],
          }),
        ]),
      ]),
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      await env.registry.setEnabled(
        { kind: "global", rootId: "bundled", rootKind: "bundled" },
        extensionId,
        false
      );

      expect(env.globalState.load().state.extensions[extensionId]).toBeUndefined();
      expect(env.registry.getSnapshot()?.roots[0].extensions[0].enabled).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  test("bundled extensions ignore user-global state records with the same identity", async () => {
    const extensionId = "author.skill";
    const bundledRoot: ExtensionRootDescriptor = {
      rootId: "bundled",
      kind: "bundled",
      path: "/fake/bundled",
    };
    const env = await createTestExtensionRegistry({
      roots: () => [bundledRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(bundledRoot, [
            makeExtension({
              extensionId,
              rootId: bundledRoot.rootId,
              rootKind: bundledRoot.kind,
              contributions: [{ type: "skills", id: "demo" }],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.globalState.setEnabled(extensionId, false);
      await env.registry.reload();

      expect(env.registry.getSnapshot()?.roots[0].extensions[0].enabled).toBe(true);
      expect(env.registry.getContributions("skills")).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });

  test("getSkillSources returns absolute body paths for available skill contributions", async () => {
    await env.registry.reload();
    const sources = env.registry.getSkillSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      name: "demo",
      extensionId: "mux.platformdemo",
      advertise: true,
    });
    expect(sources[0].bodyAbsolutePath).toBe("/fake/mux.platformdemo/demo.md");
  });

  test("getSkillSources matches availability by rootId when duplicate extension identities exist", async () => {
    const projectPath = path.join(
      os.tmpdir(),
      `mux-test-extension-project-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const projectRoot: ExtensionRootDescriptor = {
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: projectPath,
      trusted: true,
    };
    const userRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/user",
    };
    const duplicateId = "publisher.duplicate";
    const env = await createTestExtensionRegistry({
      roots: () => [userRoot, projectRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(userRoot, [
            makeExtension({
              extensionId: duplicateId,
              rootId: userRoot.rootId,
              rootKind: userRoot.kind,
              contributions: [
                { type: "skills", id: "same-skill", bodyRealPath: "/user/same-skill.md" },
              ],
            }),
          ]),
          makeRoot(projectRoot, [
            makeExtension({
              extensionId: duplicateId,
              rootId: projectRoot.rootId,
              rootKind: projectRoot.kind,
              contributions: [
                { type: "skills", id: "same-skill", bodyRealPath: "/project/same-skill.md" },
              ],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.globalState.setEnabled(duplicateId, true);
      await env.projectState.setRootTrusted(projectRoot.path, true);
      await env.projectState.setEnabled(projectRoot.path, duplicateId, true);
      await env.registry.reload();
      await env.registry.setApproval({ kind: "global" }, duplicateId);
      await env.registry.setApproval({ kind: "project-local", projectPath }, duplicateId);

      const sources = env.registry.getSkillSources(projectPath);
      expect(sources).toHaveLength(1);
      expect(sources[0]?.bodyAbsolutePath).toBe("/project/same-skill.md");
    } finally {
      await env.cleanup();
      await fsp.rm(projectPath, { recursive: true, force: true });
    }
  });

  test("getSkillSources scopes project-local Extension Name shadowing to the active project", async () => {
    const projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), "mux-ext-scoped-identity-"));
    const otherProjectPath = path.join(os.tmpdir(), `mux-ext-other-${Date.now()}`);
    const projectRoot: ExtensionRootDescriptor = {
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: projectPath,
      trusted: true,
    };
    const userRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/user",
    };
    const duplicateId = "publisher.scoped";
    const env = await createTestExtensionRegistry({
      roots: () => [userRoot, projectRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(userRoot, [
            makeExtension({
              extensionId: duplicateId,
              rootId: userRoot.rootId,
              rootKind: userRoot.kind,
              contributions: [
                { type: "skills", id: "global-only", bodyRealPath: "/user/global-only.md" },
              ],
            }),
          ]),
          makeRoot(projectRoot, [
            makeExtension({
              extensionId: duplicateId,
              rootId: projectRoot.rootId,
              rootKind: projectRoot.kind,
              contributions: [
                {
                  type: "skills",
                  id: "project-only",
                  bodyRealPath: "/project/project-only.md",
                },
              ],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.globalState.setEnabled(duplicateId, true);
      await env.projectState.setRootTrusted(projectRoot.path, true);
      await env.projectState.setEnabled(projectRoot.path, duplicateId, true);
      await env.registry.reload();
      await env.registry.setApproval(
        { kind: "global", rootId: userRoot.rootId, rootKind: "user-global" },
        duplicateId
      );
      await env.registry.setApproval({ kind: "project-local", projectPath }, duplicateId);

      expect(env.registry.getSkillSources(projectPath).map((source) => source.name)).toEqual([
        "project-only",
      ]);
      expect(env.registry.getSkillSources(otherProjectPath).map((source) => source.name)).toEqual([
        "global-only",
      ]);
    } finally {
      await env.cleanup();
      await fsp.rm(projectPath, { recursive: true, force: true });
    }
  });

  test("getSkillSources prefers active project-local skill id over global skill id", async () => {
    const projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), "mux-ext-skills-project-id-"));
    const projectRoot: ExtensionRootDescriptor = {
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: projectPath,
      trusted: true,
    };
    const userRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/user",
    };
    const env = await createTestExtensionRegistry({
      roots: () => [userRoot, projectRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(userRoot, [
            makeExtension({
              extensionId: "publisher.global",
              rootId: userRoot.rootId,
              rootKind: userRoot.kind,
              contributions: [
                { type: "skills", id: "shared-skill", bodyRealPath: "/user/shared-skill.md" },
              ],
            }),
          ]),
          makeRoot(projectRoot, [
            makeExtension({
              extensionId: "publisher.project",
              rootId: projectRoot.rootId,
              rootKind: projectRoot.kind,
              contributions: [
                { type: "skills", id: "shared-skill", bodyRealPath: "/project/shared-skill.md" },
              ],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.globalState.setEnabled("publisher.global", true);
      await env.projectState.setRootTrusted(projectRoot.path, true);
      await env.projectState.setEnabled(projectRoot.path, "publisher.project", true);
      await env.registry.reload();
      await env.registry.setApproval(
        { kind: "global", rootId: userRoot.rootId, rootKind: "user-global" },
        "publisher.global"
      );
      await env.registry.setApproval({ kind: "project-local", projectPath }, "publisher.project");

      const sources = env.registry.getSkillSources(projectPath);
      expect(sources).toHaveLength(1);
      expect(sources[0]?.bodyAbsolutePath).toBe("/project/shared-skill.md");
    } finally {
      await env.cleanup();
      await fsp.rm(projectPath, { recursive: true, force: true });
    }
  });

  test("getSkillSources keeps global skill when project-local copy is inactive", async () => {
    const projectPath = await fsp.mkdtemp(
      path.join(os.tmpdir(), "mux-ext-skills-inactive-project-")
    );
    const projectRoot: ExtensionRootDescriptor = {
      rootId: `project-local:${projectPath}`,
      kind: "project-local",
      path: projectPath,
      trusted: true,
    };
    const userRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/user",
    };
    const duplicateId = "publisher.inactive";
    const env = await createTestExtensionRegistry({
      roots: () => [userRoot, projectRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(userRoot, [
            makeExtension({
              extensionId: duplicateId,
              rootId: userRoot.rootId,
              rootKind: userRoot.kind,
              contributions: [
                { type: "skills", id: "same-skill", bodyRealPath: "/user/same-skill.md" },
              ],
            }),
          ]),
          makeRoot(projectRoot, [
            makeExtension({
              extensionId: duplicateId,
              rootId: projectRoot.rootId,
              rootKind: projectRoot.kind,
              enabled: false,
              granted: false,
              activated: false,
              contributions: [{ type: "skills", id: "same-skill", activated: false }],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.globalState.setEnabled(duplicateId, true);
      await env.projectState.setRootTrusted(projectRoot.path, true);
      await env.registry.reload();
      await env.registry.setApproval(
        { kind: "global", rootId: userRoot.rootId, rootKind: "user-global" },
        duplicateId
      );

      const sources = env.registry.getSkillSources(projectPath);
      expect(sources).toHaveLength(1);
      expect(sources[0]?.bodyAbsolutePath).toBe("/user/same-skill.md");
    } finally {
      await env.cleanup();
      await fsp.rm(projectPath, { recursive: true, force: true });
    }
  });

  test("getSkillSources uses the activation-validated body path", async () => {
    const env = await createTestExtensionRegistry({
      roots: () => [bundledRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(bundledRoot, [
            makeExtension({
              extensionId: "mux.platformdemo",
              rootId: bundledRoot.rootId,
              rootKind: bundledRoot.kind,
              isCore: true,
              contributions: [
                {
                  type: "skills",
                  id: "demo",
                  bodyPath: "raw-demo.md",
                  bodyRealPath: "/validated/package/raw-demo.md",
                },
              ],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      expect(env.registry.getSkillSources()[0]?.bodyAbsolutePath).toBe(
        "/validated/package/raw-demo.md"
      );
    } finally {
      await env.cleanup();
    }
  });
});

describe("ExtensionRegistry — state transitions", () => {
  let env: Awaited<ReturnType<typeof createTestExtensionRegistry>>;
  const root: ExtensionRootDescriptor = {
    rootId: "user-global",
    kind: "user-global",
    path: "/fake/user-global",
  };

  beforeEach(async () => {
    env = await createTestExtensionRegistry({
      roots: () => [root],
      discoverFn: (input) => {
        const enabled =
          input.state?.isEnabled?.({
            rootId: root.rootId,
            rootKind: root.kind,
            extensionId: "author.skill",
            isBundled: false,
          }) ?? false;
        const grant = input.state?.getApprovalRecord?.({
          rootId: root.rootId,
          rootKind: root.kind,
          extensionId: "author.skill",
          isBundled: false,
        });
        return {
          generatedAt: input.now ?? FROZEN_NOW,
          roots: [
            makeRoot(root, [
              makeExtension({
                extensionId: "author.skill",
                rootId: root.rootId,
                rootKind: root.kind,
                enabled,
                granted: grant !== undefined,
                activated: enabled && grant !== undefined,
                contributions: [
                  { type: "skills", id: "alpha", activated: enabled && grant !== undefined },
                ],
              }),
            ]),
          ],
        };
      },
      now: () => FROZEN_NOW,
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("enable + grant promotes the contribution into the Capability Path", async () => {
    await env.registry.setEnabled({ kind: "global" }, "author.skill", true);
    expect(env.registry.getContributions("skills")).toEqual([]);
    await env.registry.setApproval({ kind: "global" }, "author.skill");
    const contribs = env.registry.getContributions("skills");
    expect(contribs).toHaveLength(1);
    expect(contribs[0]).toMatchObject({ type: "skills", id: "alpha" });
  });

  test("Full Activation subset keeps omitted discovered skills inspectable without body-failed", async () => {
    const env = await createTestExtensionRegistry({
      roots: () => [root],
      discoverFn: (input) => {
        const enabled =
          input.state?.isEnabled?.({
            rootId: root.rootId,
            rootKind: root.kind,
            extensionId: "author.skill",
            isBundled: false,
          }) ?? false;
        const grant = input.state?.getApprovalRecord?.({
          rootId: root.rootId,
          rootKind: root.kind,
          extensionId: "author.skill",
          isBundled: false,
        });
        return {
          generatedAt: FROZEN_NOW,
          roots: [
            makeRoot(root, [
              makeExtension({
                extensionId: "author.skill",
                rootId: root.rootId,
                rootKind: root.kind,
                enabled,
                granted: grant !== undefined,
                activated: enabled && grant !== undefined,
                contributions: [
                  { type: "skills", id: "active", activated: enabled && grant !== undefined },
                  { type: "skills", id: "omitted", activated: false },
                ],
              }),
            ]),
          ],
        };
      },
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.setEnabled({ kind: "global" }, "author.skill", true);
      await env.registry.setApproval({ kind: "global" }, "author.skill");

      expect(env.registry.getContributions("skills")).toEqual([
        {
          type: "skills",
          id: "active",
          extensionId: "author.skill",
          rootId: "user-global",
          rootKind: "user-global",
        },
      ]);
      const omitted = env.registry.getDescriptors("skills").find((desc) => desc.id === "omitted");
      expect(omitted?.available).toBe(false);
      expect(omitted?.unavailableReasons).toContain("not-activated");
      expect(omitted?.unavailableReasons).not.toContain("body-failed");
    } finally {
      await env.cleanup();
    }
  });

  test("body activation failure marks the descriptor unavailable", async () => {
    const env = await createTestExtensionRegistry({
      roots: () => [root],
      discoverFn: (input) => {
        const enabled =
          input.state?.isEnabled?.({
            rootId: root.rootId,
            rootKind: root.kind,
            extensionId: "author.skill",
            isBundled: false,
          }) ?? false;
        const grant = input.state?.getApprovalRecord?.({
          rootId: root.rootId,
          rootKind: root.kind,
          extensionId: "author.skill",
          isBundled: false,
        });
        return {
          generatedAt: FROZEN_NOW,
          roots: [
            makeRoot(root, [
              makeExtension({
                extensionId: "author.skill",
                rootId: root.rootId,
                rootKind: root.kind,
                enabled,
                granted: grant !== undefined,
                activated: false,
                contributions: [{ type: "skills", id: "alpha", activated: false }],
              }),
            ]),
          ],
        };
      },
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.setEnabled({ kind: "global" }, "author.skill", true);
      await env.registry.setApproval({ kind: "global" }, "author.skill");

      const descs = env.registry.getDescriptors("skills");
      expect(descs).toHaveLength(1);
      expect(descs[0].available).toBe(false);
      expect(descs[0].unavailableReasons).toContain("body-failed");
    } finally {
      await env.cleanup();
    }
  });

  test("body activation failure does not publish partially activated siblings", async () => {
    const env = await createTestExtensionRegistry({
      roots: () => [root],
      discoverFn: (input) => {
        const enabled =
          input.state?.isEnabled?.({
            rootId: root.rootId,
            rootKind: root.kind,
            extensionId: "author.skill",
            isBundled: false,
          }) ?? false;
        const grant = input.state?.getApprovalRecord?.({
          rootId: root.rootId,
          rootKind: root.kind,
          extensionId: "author.skill",
          isBundled: false,
        });
        return {
          generatedAt: FROZEN_NOW,
          roots: [
            makeRoot(root, [
              makeExtension({
                extensionId: "author.skill",
                rootId: root.rootId,
                rootKind: root.kind,
                enabled,
                granted: grant !== undefined,
                activated: false,
                contributions: [
                  { type: "skills", id: "broken", activated: false },
                  { type: "skills", id: "healthy", activated: enabled && grant !== undefined },
                ],
              }),
            ]),
          ],
        };
      },
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.setEnabled({ kind: "global" }, "author.skill", true);
      await env.registry.setApproval({ kind: "global" }, "author.skill");

      expect(env.registry.getContributions("skills")).toEqual([]);
      const descs = env.registry.getDescriptors("skills");
      expect(descs.find((d) => d.id === "broken")?.unavailableReasons).toContain("body-failed");
      expect(descs.find((d) => d.id === "healthy")?.unavailableReasons).toContain("body-failed");
    } finally {
      await env.cleanup();
    }
  });

  test("disable removes from Capability Path but Inspection Path retains with reason", async () => {
    await env.registry.setEnabled({ kind: "global" }, "author.skill", true);
    await env.registry.setApproval({ kind: "global" }, "author.skill");
    expect(env.registry.getContributions("skills")).toHaveLength(1);

    await env.registry.setEnabled({ kind: "global" }, "author.skill", false);
    expect(env.registry.getContributions("skills")).toEqual([]);
    const descs = env.registry.getDescriptors("skills");
    expect(descs).toHaveLength(1);
    expect(descs[0].available).toBe(false);
    expect(descs[0].unavailableReasons).toContain("disabled");
  });

  test("removeApproval drops Capability Path; Inspection Path shows ungranted", async () => {
    await env.registry.setEnabled({ kind: "global" }, "author.skill", true);
    await env.registry.setApproval({ kind: "global" }, "author.skill");
    expect(env.registry.getContributions("skills")).toHaveLength(1);

    await env.registry.removeApproval({ kind: "global" }, "author.skill");
    expect(env.registry.getContributions("skills")).toEqual([]);
    const descs = env.registry.getDescriptors("skills");
    expect(descs[0].unavailableReasons).toContain("ungranted");
  });

  test("setApproval reloads before live manifest lookup when only cache/empty live state exists", async () => {
    await env.registry.setApproval(
      { kind: "global", rootId: "user-global", rootKind: "user-global" },
      "author.skill"
    );

    expect(env.globalState.load().state.extensions["author.skill"]?.approval).toBeDefined();
    expect(env.registry.getSnapshot()?.roots[0].extensions[0].extensionId).toBe("author.skill");
  });

  test("setApproval persists live capability approval fields", async () => {
    await env.registry.reload();
    await env.registry.setApproval(
      { kind: "global", rootId: "user-global", rootKind: "user-global" },
      "author.skill"
    );

    const persisted = env.globalState.load().state.extensions["author.skill"]?.approval;
    expect(persisted).toEqual({
      grantedPermissions: ["skill.register"],
      requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
    });
  });

  test("approval records without source identity keep the Capability Path available", async () => {
    await env.registry.setEnabled({ kind: "global" }, "author.skill", true);
    await env.globalState.setApproval("author.skill", SAMPLE_GRANT);
    await env.registry.reload();

    expect(env.registry.getContributions("skills")).toHaveLength(1);
    const descs = env.registry.getDescriptors("skills");
    expect(descs[0].available).toBe(true);
    expect(descs[0].unavailableReasons).not.toContain("pending-reapproval");
  });

  test("setApproval hashes the user-global manifest when bundled root shares the extension identity", async () => {
    const extensionId = "author.same";
    const bundledRoot: ExtensionRootDescriptor = {
      rootId: "bundled",
      kind: "bundled",
      path: "/fake/bundled",
    };
    const userRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user-global",
    };
    const env = await createTestExtensionRegistry({
      roots: () => [bundledRoot, userRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(bundledRoot, [
            makeExtension({
              extensionId,
              rootId: bundledRoot.rootId,
              rootKind: bundledRoot.kind,
              contributions: [{ type: "agents", id: "bundled-agent" }],
            }),
          ]),
          makeRoot(userRoot, [
            makeExtension({
              extensionId,
              rootId: userRoot.rootId,
              rootKind: userRoot.kind,
              contributions: [{ type: "skills", id: "user-skill" }],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      await env.registry.setApproval(
        { kind: "global", rootId: userRoot.rootId, rootKind: "user-global" },
        extensionId
      );

      const persisted = env.globalState.load().state.extensions[extensionId]?.approval;
      expect(persisted?.requestedPermissionsHash).toBe(
        hashRequestedPermissions(["skill.register"])
      );
      const permissions =
        env.registry.getSnapshot()?.permissions[
          extensionPermissionKey(userRoot.rootId, extensionId)
        ];
      expect(permissions?.driftStatus).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  test("setApproval rejects extensions missing from the live scope", async () => {
    await env.registry.reload();

    let error: unknown;
    try {
      await env.registry.setApproval({ kind: "global" }, "author.missing");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not installed in the requested scope/);
    expect(env.globalState.load().state.extensions["author.missing"]?.approval).toBeUndefined();
  });

  test("setApproval stores a canonical requestedPermissionsHash from the live manifest", async () => {
    await env.registry.setEnabled({ kind: "global" }, "author.skill", true);
    await env.registry.setApproval({ kind: "global" }, "author.skill");

    const persisted = env.globalState.load().state.extensions["author.skill"]?.approval;
    expect(persisted?.requestedPermissionsHash).not.toBe("");
    expect(persisted?.requestedPermissionsHash).toMatch(/^[0-9a-f]{64}$/);

    const snapshot = env.registry.getSnapshot();
    expect(
      snapshot?.permissions[extensionPermissionKey("user-global", "author.skill")]?.driftStatus
    ).toBeNull();
  });
});

describe("ExtensionRegistry — trust transitions", () => {
  let env: Awaited<ReturnType<typeof createTestExtensionRegistry>>;
  let projectPath: string;
  const projectRootId = "project::/p";

  beforeEach(async () => {
    env = await createTestExtensionRegistry({
      roots: async () => {
        const trusted = await env.projectState.isRootTrusted(projectPath);
        return [
          {
            rootId: projectRootId,
            kind: "project-local",
            path: projectPath,
            trusted,
          },
        ];
      },
      discoverFn: (input) => {
        const root = input.roots[0];
        if (root.kind === "project-local" && root.trusted !== true) {
          return {
            generatedAt: input.now ?? FROZEN_NOW,
            roots: [
              {
                rootId: root.rootId,
                kind: "project-local",
                path: root.path,
                trusted: false,
                rootExists: true,
                state: "ready",
                extensions: [],
                diagnostics: [],
              },
            ],
          };
        }
        return {
          generatedAt: input.now ?? FROZEN_NOW,
          roots: [makeRoot(root, [], true)],
        };
      },
      now: () => FROZEN_NOW,
    });
    projectPath = path.join(env.tempDir, "project");
    await fsp.mkdir(projectPath, { recursive: true });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("trustRoot flips persisted state and reloads", async () => {
    await env.registry.reload();
    expect(env.registry.getSnapshot()!.roots[0].trusted).toBe(false);

    await env.registry.trustRoot(projectPath);
    expect(env.registry.getSnapshot()!.roots[0].trusted).toBe(true);
    expect(await env.projectState.isRootTrusted(projectPath)).toBe(true);
  });

  test("untrustRoot flips trusted=false but preserves approval records", async () => {
    await env.projectState.setRootTrusted(projectPath, true);
    await env.projectState.setApproval(projectPath, "author.skill", SAMPLE_GRANT);
    await env.registry.reload();
    expect(env.registry.getSnapshot()!.roots[0].trusted).toBe(true);

    await env.registry.untrustRoot(projectPath);
    expect(env.registry.getSnapshot()!.roots[0].trusted).toBe(false);
    const stateAfter = (await env.projectState.load(projectPath)).state;
    expect(stateAfter.rootTrusted).toBe(false);
    expect(stateAfter.extensions["author.skill"]?.approval).toEqual(SAMPLE_GRANT);
  });
});

describe("ExtensionRegistry — atomic snapshot replacement", () => {
  test("getSnapshot() during in-flight reload returns the previous coherent snapshot", async () => {
    const root: ExtensionRootDescriptor = {
      rootId: "bundled",
      kind: "bundled",
      path: "/fake/bundled",
    };
    let callCount = 0;
    let signalStarted: (() => void) | undefined;
    let signalRelease: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });

    const env = await createTestExtensionRegistry({
      roots: () => [root],
      discoverFn: async (input) => {
        callCount += 1;
        if (callCount === 2) {
          signalStarted!();
          await releasePromise;
        }
        return {
          generatedAt: input.now ?? FROZEN_NOW + callCount,
          roots: [
            makeRoot(root, [
              makeExtension({
                extensionId: `mux.snap${callCount}`,
                rootId: root.rootId,
                rootKind: "bundled",
                granted: false,
                activated: false,
                contributions: [],
              }),
            ]),
          ],
        };
      },
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      expect(env.registry.getSnapshot()?.roots[0].extensions[0].extensionId).toBe("mux.snap1");

      // Begin a second reload; await its discoverFn entry before assertion.
      const second = env.registry.reload();
      await startedPromise;
      // The previous snapshot remains visible until the new one is computed.
      expect(env.registry.getSnapshot()?.roots[0].extensions[0].extensionId).toBe("mux.snap1");
      signalRelease!();
      await second;
      expect(env.registry.getSnapshot()?.roots[0].extensions[0].extensionId).toBe("mux.snap2");
    } finally {
      await env.cleanup();
    }
  });
});

describe("ExtensionRegistry — per-root reload", () => {
  test("reloadRoot performs a full coherent reload", async () => {
    const bundled: ExtensionRootDescriptor = {
      rootId: "bundled",
      kind: "bundled",
      path: "/fake/bundled",
    };
    const userGlobal: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user",
    };
    let bundledCount = 0;
    let userCount = 0;
    const env = await createTestExtensionRegistry({
      roots: () => [bundled, userGlobal],
      discoverFn: (input) => {
        const roots = input.roots.map((r) => {
          if (r.rootId === bundled.rootId) bundledCount += 1;
          else userCount += 1;
          return makeRoot(r, []);
        });
        return { generatedAt: FROZEN_NOW, roots };
      },
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reload();
      expect(bundledCount).toBe(1);
      expect(userCount).toBe(1);

      await env.registry.reloadRoot(userGlobal.rootId);
      expect(bundledCount).toBe(2);
      expect(userCount).toBe(2);
    } finally {
      await env.cleanup();
    }
  });

  test("reloadRoot before any reload falls back to a full reload", async () => {
    const bundled: ExtensionRootDescriptor = {
      rootId: "bundled",
      kind: "bundled",
      path: "/fake/bundled",
    };
    let totalRoots = 0;
    const env = await createTestExtensionRegistry({
      roots: () => [bundled],
      discoverFn: (input) => {
        totalRoots += input.roots.length;
        return {
          generatedAt: FROZEN_NOW,
          roots: input.roots.map((r) => makeRoot(r, [])),
        };
      },
      now: () => FROZEN_NOW,
    });
    try {
      await env.registry.reloadRoot(bundled.rootId);
      // Cold-start fall-through ran a full reload (one root).
      expect(totalRoots).toBe(1);
      expect(env.registry.getSnapshot()).not.toBeNull();
    } finally {
      await env.cleanup();
    }
  });
});

describe("ExtensionRegistry — multi-window propagation", () => {
  test("a mutation through registry A becomes visible in registry B after reload", async () => {
    const tempDir = path.join(
      os.tmpdir(),
      `mux-registry-multi-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fsp.mkdir(tempDir, { recursive: true });
    try {
      const root: ExtensionRootDescriptor = {
        rootId: "user-global",
        kind: "user-global",
        path: "/fake/user",
      };
      const sharedDiscover: DiscoverFn = (input) => {
        const grant = input.state?.getApprovalRecord?.({
          rootId: root.rootId,
          rootKind: root.kind,
          extensionId: "author.skill",
          isBundled: false,
        });
        const enabled =
          input.state?.isEnabled?.({
            rootId: root.rootId,
            rootKind: root.kind,
            extensionId: "author.skill",
            isBundled: false,
          }) ?? false;
        return {
          generatedAt: FROZEN_NOW,
          roots: [
            makeRoot(root, [
              makeExtension({
                extensionId: "author.skill",
                rootId: root.rootId,
                rootKind: root.kind,
                enabled,
                granted: grant !== undefined,
                activated: enabled && grant !== undefined,
                contributions: [
                  { type: "skills", id: "alpha", activated: enabled && grant !== undefined },
                ],
              }),
            ]),
          ],
        };
      };

      const cfgA = new Config(tempDir);
      const cfgB = new Config(tempDir);
      const aReg = new ExtensionRegistry({
        roots: () => [root],
        globalState: new GlobalExtensionStateService(cfgA),
        projectState: new ProjectExtensionStateService(getProjectExtensionStateRoot(tempDir)),
        discoverFn: sharedDiscover,
        now: () => FROZEN_NOW,
      });
      const bReg = new ExtensionRegistry({
        roots: () => [root],
        globalState: new GlobalExtensionStateService(cfgB),
        projectState: new ProjectExtensionStateService(getProjectExtensionStateRoot(tempDir)),
        discoverFn: sharedDiscover,
        now: () => FROZEN_NOW,
      });
      await aReg.reload();
      await bReg.reload();
      expect(aReg.getContributions("skills")).toEqual([]);
      expect(bReg.getContributions("skills")).toEqual([]);

      await aReg.setEnabled({ kind: "global" }, "author.skill", true);
      await aReg.setApproval({ kind: "global" }, "author.skill");
      expect(aReg.getContributions("skills")).toHaveLength(1);

      // B has not yet reloaded; it still sees the prior snapshot.
      expect(bReg.getContributions("skills")).toEqual([]);

      await bReg.reload();
      expect(bReg.getContributions("skills")).toHaveLength(1);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("ExtensionRegistry — capability vs inspection independence", () => {
  test("Capability Path ignores a mutated cache; Inspection Path reads cache only on cold start", async () => {
    const env = await createTestExtensionRegistry({
      roots: () => [],
      discoverFn: () => ({ generatedAt: FROZEN_NOW, roots: [] }),
      withSnapshotCache: true,
      appVersion: "0.0.0-test",
      now: () => FROZEN_NOW,
    });
    try {
      const cachePath = path.join(env.tempDir, "extension-snapshot.cache.json");
      const stateFilePath = path.join(env.tempDir, "config.json");

      // Hand-craft a cache file that *claims* a contribution exists. The
      // Capability Path must never consult this; the Inspection Path may
      // surface it during cold start.
      const fakeCache = {
        cacheVersion: 1,
        appVersion: "0.0.0-test",
        manifestVersion: 1,
        stateFileFingerprints: [{ path: stateFilePath, exists: false, mtimeMs: 0, sha256: "" }],
        snapshot: {
          generatedAt: 1,
          roots: [],
          availableContributions: [
            {
              type: "skills",
              id: "fake-from-cache",
              extensionId: "evil.cache",
              rootId: "evil",
              rootKind: "user-global",
            },
          ],
          resolverDiagnostics: [],
          descriptors: [
            {
              type: "skills",
              id: "fake-from-cache",
              extensionId: "evil.cache",
              rootId: "evil",
              rootKind: "user-global",
              available: true,
              unavailableReasons: [],
              missingPermissions: [],
            },
          ],
          permissions: {},
          staleRecords: [],
        },
      };
      await fsp.writeFile(cachePath, JSON.stringify(fakeCache));

      await env.registry.loadFromCache();

      // Cold-start: Capability Path is empty (no live snapshot yet) — even
      // though a cached snapshot is present.
      expect(env.registry.getContributions("skills")).toEqual([]);

      // Inspection Path uses the cached snapshot.
      const cachedDescs = env.registry.getDescriptors("skills");
      expect(cachedDescs).toHaveLength(1);
      expect(cachedDescs[0].id).toBe("fake-from-cache");

      // Once we run a real reload, Inspection Path switches to the live
      // (empty) snapshot and the cache lie disappears.
      await env.registry.reload();
      expect(env.registry.getDescriptors("skills")).toEqual([]);
      expect(env.registry.getContributions("skills")).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });
});

describe("ExtensionRegistry — stale records", () => {
  test("approval records for vanished Extensions surface in Inspection Path; Forget removes them", async () => {
    const env = await createTestExtensionRegistry({
      roots: () => [],
      discoverFn: () => ({ generatedAt: FROZEN_NOW, roots: [] }),
      now: () => FROZEN_NOW,
    });
    try {
      // Seed an approval record for an Extension that does not exist in any root.
      await env.globalState.setApproval("vanished.author.skill", SAMPLE_GRANT);
      await env.registry.reload();
      const stale = env.registry.getStaleRecords();
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({
        scope: "global",
        extensionId: "vanished.author.skill",
        approval: SAMPLE_GRANT,
      });

      // Forget removes the persisted record (explicit user action — never auto).
      await env.registry.forgetStale({ kind: "global" }, "vanished.author.skill");
      expect(env.registry.getStaleRecords()).toEqual([]);
      expect(env.globalState.load().state.extensions["vanished.author.skill"]).toBeUndefined();
    } finally {
      await env.cleanup();
    }
  });

  test("global stale records remain visible when the same extension is live only as bundled", async () => {
    const extensionId = "mux.platformdemo";
    const bundledRoot: ExtensionRootDescriptor = {
      rootId: "bundled",
      kind: "bundled",
      path: "/fake/bundled",
    };
    const env = await createTestExtensionRegistry({
      roots: () => [bundledRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(bundledRoot, [
            makeExtension({
              extensionId,
              rootId: bundledRoot.rootId,
              rootKind: bundledRoot.kind,
              contributions: [{ type: "skills", id: "mux-extensions" }],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.globalState.setApproval(extensionId, SAMPLE_GRANT);
      await env.registry.reload();

      const staleRecords = env.registry.getStaleRecords();
      expect(staleRecords).toHaveLength(1);
      expect(staleRecords[0]?.scope).toBe("global");
      expect(staleRecords[0]?.extensionId).toBe(extensionId);
    } finally {
      await env.cleanup();
    }
  });

  test("project-local approvals are not stale while the root is untrusted", async () => {
    const projectPath = path.join(os.tmpdir(), `mux-stale-untrusted-project-${Date.now()}`);
    const projectRoot: ExtensionRootDescriptor = {
      rootId: staleProjectLocalRootId(projectPath),
      kind: "project-local",
      path: projectPath,
      trusted: false,
    };
    const env = await createTestExtensionRegistry({
      roots: () => [projectRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [makeRoot(projectRoot, [], false)],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.projectState.setApproval(projectPath, "author.skill", SAMPLE_GRANT);
      await env.registry.reload();

      expect(env.registry.getStaleRecords()).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  test("project-local stale records remain visible when the same extension is live globally", async () => {
    const projectPath = path.join(os.tmpdir(), `mux-stale-project-${Date.now()}`);
    const userRoot: ExtensionRootDescriptor = {
      rootId: "user-global",
      kind: "user-global",
      path: "/fake/user-global",
    };
    const projectRoot: ExtensionRootDescriptor = {
      rootId: staleProjectLocalRootId(projectPath),
      kind: "project-local",
      path: path.join(projectPath, ".mux", "extensions"),
      trusted: true,
    };
    const extensionId = "publisher.shared";
    const env = await createTestExtensionRegistry({
      roots: () => [userRoot, projectRoot],
      discoverFn: () => ({
        generatedAt: FROZEN_NOW,
        roots: [
          makeRoot(userRoot, [
            makeExtension({
              extensionId,
              rootId: userRoot.rootId,
              rootKind: userRoot.kind,
              contributions: [{ type: "skills", id: "shared-skill" }],
            }),
          ]),
        ],
      }),
      now: () => FROZEN_NOW,
    });
    try {
      await env.globalState.setEnabled(extensionId, true);
      await env.globalState.setApproval(extensionId, SAMPLE_GRANT);
      await env.projectState.setRootTrusted(projectPath, true);
      await env.projectState.setEnabled(projectPath, extensionId, true);
      await env.projectState.setApproval(projectPath, extensionId, SAMPLE_GRANT);
      await env.registry.reload();

      const staleRecords = env.registry.getStaleRecords();
      expect(staleRecords).toHaveLength(1);
      expect(staleRecords[0]?.scope).toBe("project-local");
      expect(staleRecords[0]?.projectPath).toBe(projectPath);
      expect(staleRecords[0]?.extensionId).toBe(extensionId);
    } finally {
      await env.cleanup();
      await fsp.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe("ExtensionRegistry — discovers real extensions when wired to discoverExtensions", () => {
  test("discovers a fixture-bundled root through the real discovery pipeline", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-registry-real-discovery-"));
    try {
      const extensionsDir = path.join(tempDir, "extensions");
      const demoPath = path.join(extensionsDir, "mux-platform-demo");
      await fsp.mkdir(demoPath, { recursive: true });
      await fsp.writeFile(
        path.join(demoPath, "extension.ts"),
        `
          export const manifest = {
            name: "mux-platform-demo",
            capabilities: { skills: true },
          };
          export function activate(ctx) {
            ctx.skills.register({ name: "demo", bodyPath: "./SKILL.md" });
          }
        `
      );
      await fsp.writeFile(
        path.join(demoPath, "SKILL.md"),
        "---\nname: demo\ndescription: Demo skill\n---\n# demo"
      );

      const env = await createTestExtensionRegistry({
        roots: () => [
          {
            rootId: "bundled",
            kind: "bundled",
            path: extensionsDir,
            isCore: true,
          },
        ],
        discoverFn: discoverExtensions,
        now: () => FROZEN_NOW,
      });
      try {
        // Seed grant so activation passes for the bundled core ext.
        await env.globalState.setEnabled("mux-platform-demo", true);
        await env.globalState.setApproval("mux-platform-demo", {
          grantedPermissions: ["skill.register"],
          requestedPermissionsHash: "hash",
        });
        await env.registry.reload();
        const contribs = env.registry.getContributions("skills");
        expect(contribs).toHaveLength(1);
        expect(contribs[0].id).toBe("demo");
      } finally {
        await env.cleanup();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("does not advertise previous activation when hot reload breaks a skill body", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-registry-hot-reload-"));
    try {
      const extensionsDir = path.join(tempDir, "extensions");
      const modulePath = path.join(extensionsDir, "acme-review");
      const skillPath = path.join(modulePath, "skills", "review", "SKILL.md");
      await fsp.mkdir(path.dirname(skillPath), { recursive: true });
      await fsp.writeFile(
        path.join(modulePath, "extension.ts"),
        `
          export const manifest = {
            name: "acme-review",
            capabilities: { skills: true },
          };
          export function activate(ctx) {
            ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
          }
        `
      );
      await fsp.writeFile(
        skillPath,
        "---\nname: review\ndescription: Review helper\n---\n# Review\n"
      );

      const env = await createTestExtensionRegistry({
        roots: () => [
          {
            rootId: "user-global",
            kind: "user-global",
            path: extensionsDir,
          },
        ],
        discoverFn: discoverExtensions,
        now: () => FROZEN_NOW,
      });
      try {
        await env.globalState.setEnabled("acme-review", true);
        await env.globalState.setApproval("acme-review", {
          grantedPermissions: ["skill.register"],
          requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
        });

        await env.registry.reload();
        expect(env.registry.getContributions("skills")).toHaveLength(1);

        await fsp.writeFile(skillPath, "---\nname: other\ndescription: Broken\n---\n# Broken\n");
        await env.registry.reload();

        expect(env.registry.getContributions("skills")).toHaveLength(0);
      } finally {
        await env.cleanup();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("does not restore previous good activation when Full Activation disposes a skill", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-registry-hot-reload-dispose-"));
    try {
      const extensionsDir = path.join(tempDir, "extensions");
      const modulePath = path.join(extensionsDir, "acme-review");
      const skillPath = path.join(modulePath, "skills", "review", "SKILL.md");
      await fsp.mkdir(path.dirname(skillPath), { recursive: true });
      await fsp.writeFile(
        skillPath,
        "---\nname: review\ndescription: Review helper\n---\n# Review\n"
      );
      await fsp.writeFile(
        path.join(modulePath, "extension.ts"),
        `
          export const manifest = {
            name: "acme-review",
            capabilities: { skills: true },
          };
          export function activate(ctx) {
            ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
          }
        `
      );

      const env = await createTestExtensionRegistry({
        roots: () => [{ rootId: "user-global", kind: "user-global", path: extensionsDir }],
        discoverFn: discoverExtensions,
        now: () => FROZEN_NOW,
      });
      try {
        await env.globalState.setEnabled("acme-review", true);
        await env.globalState.setApproval("acme-review", {
          grantedPermissions: ["skill.register"],
          requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
        });
        await env.registry.reload();
        expect(env.registry.getContributions("skills")).toHaveLength(1);

        await fsp.writeFile(
          path.join(modulePath, "extension.ts"),
          `
            export const manifest = {
              name: "acme-review",
              capabilities: { skills: true },
            };
            export function activate(ctx) {
              const registration = ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
              if (ctx.mode === "activate") registration.dispose();
            }
          `
        );
        await env.registry.reload();

        expect(env.registry.getContributions("skills")).toEqual([]);
      } finally {
        await env.cleanup();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("capability revocation shuts down previous hot-reload activation fallback", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-registry-hot-reload-revoke-"));
    try {
      const extensionsDir = path.join(tempDir, "extensions");
      const modulePath = path.join(extensionsDir, "acme-review");
      const skillPath = path.join(modulePath, "skills", "review", "SKILL.md");
      await fsp.mkdir(path.dirname(skillPath), { recursive: true });
      await fsp.writeFile(
        path.join(modulePath, "extension.ts"),
        `
          export const manifest = {
            name: "acme-review",
            capabilities: { skills: true },
          };
          export function activate(ctx) {
            ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
          }
        `
      );
      await fsp.writeFile(
        skillPath,
        "---\nname: review\ndescription: Review helper\n---\n# Review\n"
      );

      const env = await createTestExtensionRegistry({
        roots: () => [{ rootId: "user-global", kind: "user-global", path: extensionsDir }],
        discoverFn: discoverExtensions,
        now: () => FROZEN_NOW,
      });
      try {
        await env.globalState.setEnabled("acme-review", true);
        await env.globalState.setApproval("acme-review", {
          grantedPermissions: ["skill.register"],
          requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
        });
        await env.registry.reload();
        expect(env.registry.getContributions("skills")).toHaveLength(1);

        await env.globalState.removeApproval("acme-review");
        await fsp.writeFile(skillPath, "---\nname: other\ndescription: Broken\n---\n# Broken\n");
        await env.registry.reload();

        expect(env.registry.getContributions("skills")).toEqual([]);
      } finally {
        await env.cleanup();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
