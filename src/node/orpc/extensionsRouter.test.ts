import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { createRouterClient, ORPCError } from "@orpc/server";

import {
  createTestExtensionRegistry,
  type TestExtensionRegistry,
} from "@/node/extensions/testExtensionRegistry";
import type {
  DiscoveredExtension,
  ExtensionRootDescriptor,
  RootDiscoveryResult,
} from "@/node/extensions/extensionDiscoveryService";
import type { DiscoverFn } from "@/node/extensions/extensionRegistryService";
import type { ValidatedManifest } from "@/common/extensions/manifestValidator";
import { hashRequestedPermissions } from "@/common/extensions/permissionCalculator";
import type { ApprovalRecord } from "@/common/extensions/globalExtensionState";
import type { ORPCContext } from "./context";
import { router } from "./router";

const execFileAsync = promisify(execFile);

const FROZEN_NOW = 1_700_000_000_000;

const SAMPLE_GRANT: ApprovalRecord = {
  grantedPermissions: ["skill.register"],
  requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
};

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trim();
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function makeManifest(
  id: string,
  contributions: Array<{ type: string; id: string }>
): ValidatedManifest {
  return {
    manifestVersion: 1,
    id,
    requestedPermissions: contributions.map((c) => `${singularOf(c.type)}.register`),
    contributions: contributions.map((c, index) => ({
      type: c.type,
      id: c.id,
      index,
      descriptor: { descriptorVersion: 1, id: c.id },
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
  enabled?: boolean;
  granted?: boolean;
  activated?: boolean;
  contributions?: Array<{ type: string; id: string }>;
}): DiscoveredExtension {
  const contribs = (opts.contributions ?? []).map((c, index) => ({
    type: c.type,
    id: c.id,
    index,
    activated: opts.activated ?? true,
  }));
  return {
    extensionId: opts.extensionId,
    rootId: opts.rootId,
    rootKind: opts.rootKind,
    isCore: false,
    modulePath: `/fake/${opts.extensionId}`,
    manifest: makeManifest(opts.extensionId, opts.contributions ?? []),
    contributions: contribs,
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

function makeContext(env: TestExtensionRegistry): ORPCContext {
  // Only the extensionRegistry field is exercised by the extensions IPC routes,
  // so a partial context with the registry plugged in is sufficient.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- IPC handlers under test only read context.extensionRegistry.
  return { config: env.config, extensionRegistry: env.registry } as ORPCContext;
}

describe("extensions IPC — list / reload / onChanged", () => {
  let env: TestExtensionRegistry;

  const userGlobalRoot: ExtensionRootDescriptor = {
    rootId: "user-global",
    kind: "user-global",
    path: "/fake/user-global",
  };

  beforeEach(async () => {
    env = await createTestExtensionRegistry({
      roots: () => [userGlobalRoot],
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(roots[0], [
          makeExtension({
            extensionId: "author.skill",
            rootId: "user-global",
            rootKind: "user-global",
            contributions: [{ type: "skills", id: "demo" }],
          }),
        ]),
      ]),
      now: () => FROZEN_NOW,
    });
    await env.globalState.setApproval("author.skill", SAMPLE_GRANT);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("list returns null before any reload", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    const snap = await client.extensions.list();
    expect(snap).toBeNull();
  });

  test("reload populates the live snapshot and list returns it", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    await client.extensions.reload({});

    const snap = await client.extensions.list();
    expect(snap).not.toBeNull();
    expect(snap!.roots).toHaveLength(1);
    expect(snap!.roots[0].rootId).toBe("user-global");
    expect(snap!.availableContributions).toHaveLength(1);
    expect(snap!.availableContributions[0]).toMatchObject({
      type: "skills",
      id: "demo",
      extensionId: "author.skill",
    });
  });

  test("initializeUserRoot creates the local Extension Module authoring root", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });

    await client.extensions.initializeUserRoot();

    const rootPath = path.join(env.config.rootDir, "extensions", "local");
    const stat = await fs.stat(rootPath);
    expect(stat.isDirectory()).toBe(true);
    await expect(
      fs.access(path.join(env.config.rootDir, "extensions", "package.json"))
    ).rejects.toThrow();
  });

  test("installGitSource installs a git Extension Module and refreshes the registry", async () => {
    const repoPath = path.join(env.tempDir, "repo");
    await fs.mkdir(repoPath, { recursive: true });
    await git(["init", "--initial-branch", "main"], repoPath);
    await git(["config", "user.email", "mux@example.com"], repoPath);
    await git(["config", "user.name", "Mux Test"], repoPath);
    await writeFile(
      path.join(repoPath, "extension.ts"),
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
    await writeFile(
      path.join(repoPath, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review helper\n---\n# Review\n"
    );
    await git(["add", "."], repoPath);
    await git(["commit", "-m", "add extension"], repoPath);
    const resolvedSha = await git(["rev-parse", "HEAD"], repoPath);
    const client = createRouterClient(router(), { context: makeContext(env) });

    expect(env.registry.getSnapshot()).toBeNull();
    const result = await client.extensions.installGitSource({ coordinate: `${repoPath}@main` });

    expect(result).toMatchObject({
      extensionName: "acme-review",
      resolvedSha,
      activePath: path.join(env.config.rootDir, "extensions", "global", "acme-review"),
    });
    expect(result.contentHash.startsWith("sha256:")).toBe(true);
    const entrypointStat = await fs.stat(path.join(result.activePath, "extension.ts"));
    expect(entrypointStat.isFile()).toBe(true);
    expect(env.registry.getSnapshot()).not.toBeNull();
  });

  test("reload({ rootId }) routes through reloadRoot and produces a snapshot", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    await client.extensions.reload({});
    await client.extensions.reload({ rootId: "user-global" });

    const snap = await client.extensions.list();
    expect(snap!.roots).toHaveLength(1);
  });

  test("onChanged multicasts to multiple subscribers and emits per snapshot replacement", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();

    const collect = async (it: AsyncIterable<void>): Promise<number> => {
      let count = 0;
      try {
        for await (const _ of it) {
          count += 1;
          if (count >= 2) break;
        }
      } catch {
        // Iterator throws on abort; counts already captured.
      }
      return count;
    };

    const it1 = await client.extensions.onChanged(undefined, { signal: ctrl1.signal });
    const it2 = await client.extensions.onChanged(undefined, { signal: ctrl2.signal });

    const p1 = collect(it1);
    const p2 = collect(it2);

    await client.extensions.reload({});
    await client.extensions.reload({});

    const [c1, c2] = await Promise.race([
      Promise.all([p1, p2]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for extension events")), 1000)
      ),
    ]);
    ctrl1.abort();
    ctrl2.abort();

    expect(c1).toBeGreaterThanOrEqual(2);
    expect(c2).toBeGreaterThanOrEqual(2);
  });
});

describe("extensions IPC — trust / untrust", () => {
  let env: TestExtensionRegistry;
  let projectPath: string;
  let projectRootId: string;
  let projectRoot: ExtensionRootDescriptor;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ext-ipc-trust-"));
    projectRootId = `project-local:${projectPath}`;
    projectRoot = {
      rootId: projectRootId,
      kind: "project-local",
      path: projectPath,
      trusted: true,
    };
    env = await createTestExtensionRegistry({
      roots: async () => {
        const projectTrusted = env.config.loadConfigOrDefault().projects.get(projectPath)?.trusted;
        const rootTrusted = await env.projectState.isRootTrusted(projectPath);
        return [{ ...projectRoot, trusted: projectTrusted === true && rootTrusted }];
      },
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(roots[0], [], roots[0].trusted ?? false),
      ]),
      now: () => FROZEN_NOW,
    });
    await env.config.editConfig((config) => {
      config.projects.set(projectPath, { workspaces: [], trusted: true });
      return config;
    });
    // Seed initial trust so the snapshot has the root before we toggle.
    await env.projectState.setRootTrusted(projectPath, true);
  });

  afterEach(async () => {
    await env.cleanup();
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  test("trustRoot flips on-disk trust, project trust, and re-runs reload", async () => {
    await env.projectState.setRootTrusted(projectPath, false);
    await env.config.editConfig((config) => {
      config.projects.set(projectPath, { workspaces: [], trusted: false });
      return config;
    });
    await env.registry.reload();

    const client = createRouterClient(router(), { context: makeContext(env) });
    await client.extensions.trustRoot({ rootId: projectRootId });

    expect(env.config.loadConfigOrDefault().projects.get(projectPath)?.trusted).toBe(true);
    expect(await env.projectState.isRootTrusted(projectPath)).toBe(true);
    const snap = await client.extensions.list();
    expect(snap!.roots[0].trusted).toBe(true);
  });

  test("trustRoot rolls back project trust when extension trust fails", async () => {
    await env.projectState.setRootTrusted(projectPath, false);
    await env.config.editConfig((config) => {
      config.projects.set(projectPath, { workspaces: [], trusted: false });
      return config;
    });
    await env.registry.reload();
    const originalTrustRoot = env.registry.trustRoot.bind(env.registry);
    env.registry.trustRoot = (async (pathToTrust: string) => {
      await env.projectState.setRootTrusted(pathToTrust, true);
      throw new Error("trust failed");
    }) as typeof env.registry.trustRoot;
    const client = createRouterClient(router(), { context: makeContext(env) });

    try {
      await expect(client.extensions.trustRoot({ rootId: projectRootId })).rejects.toBeInstanceOf(
        Error
      );
      expect(env.config.loadConfigOrDefault().projects.get(projectPath)?.trusted).toBe(false);
      expect(await env.projectState.isRootTrusted(projectPath)).toBe(false);
    } finally {
      env.registry.trustRoot = originalTrustRoot;
    }
  });

  test("untrustRoot flips on-disk trust, project trust, and re-runs reload", async () => {
    await env.registry.reload();
    const client = createRouterClient(router(), { context: makeContext(env) });
    await client.extensions.untrustRoot({ rootId: projectRootId });

    expect(env.config.loadConfigOrDefault().projects.get(projectPath)?.trusted).toBe(false);
    expect(await env.projectState.isRootTrusted(projectPath)).toBe(false);
  });

  test("trustRoot rejects rootIds that aren't project-local", async () => {
    // Seed with a user-global root that should never accept trust mutations.
    const userRootId = "user-global";
    const env2 = await createTestExtensionRegistry({
      roots: () => [{ rootId: userRootId, kind: "user-global", path: "/fake/user-global" }],
      discoverFn: stubDiscoverFn(({ roots }) => [makeRoot(roots[0], [])]),
      now: () => FROZEN_NOW,
    });
    await env2.registry.reload();
    const client = createRouterClient(router(), { context: makeContext(env2) });

    await expect(client.extensions.trustRoot({ rootId: userRootId })).rejects.toBeInstanceOf(
      ORPCError
    );
    await env2.cleanup();
  });

  test("trustRoot rejects unknown rootIds", async () => {
    await env.registry.reload();
    const client = createRouterClient(router(), { context: makeContext(env) });
    await expect(client.extensions.trustRoot({ rootId: "no-such-root" })).rejects.toBeInstanceOf(
      ORPCError
    );
  });
});

describe("extensions IPC — enable / disable / approve / revokeApproval", () => {
  let env: TestExtensionRegistry;
  const userRoot: ExtensionRootDescriptor = {
    rootId: "user-global",
    kind: "user-global",
    path: "/fake/user-global",
  };

  beforeEach(async () => {
    env = await createTestExtensionRegistry({
      roots: () => [userRoot],
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(roots[0], [
          makeExtension({
            extensionId: "author.skill",
            rootId: "user-global",
            rootKind: "user-global",
            contributions: [{ type: "skills", id: "demo" }],
          }),
        ]),
      ]),
      now: () => FROZEN_NOW,
    });
    await env.registry.reload();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("enable / disable update the global state record", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });

    await client.extensions.disable({ rootId: "user-global", extensionId: "author.skill" });
    expect(env.globalState.load().state.extensions["author.skill"]?.enabled).toBe(false);

    await client.extensions.enable({ rootId: "user-global", extensionId: "author.skill" });
    expect(env.globalState.load().state.extensions["author.skill"]?.enabled).toBe(true);
  });

  test("approve / revokeApproval persist the approval record", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });

    await client.extensions.approve({
      rootId: "user-global",
      extensionId: "author.skill",
    });
    const persisted = env.globalState.load().state.extensions["author.skill"]?.approval;
    // Registry derives the approval record from the live manifest so drift
    // detection works correctly; assert everything except the hash and verify
    // the hash is a canonical SHA-256 instead.
    expect(persisted).toMatchObject({
      grantedPermissions: SAMPLE_GRANT.grantedPermissions,
    });
    expect(persisted?.requestedPermissionsHash).toMatch(/^[0-9a-f]{64}$/);

    await client.extensions.revokeApproval({ rootId: "user-global", extensionId: "author.skill" });
    expect(env.globalState.load().state.extensions["author.skill"]?.approval).toBeUndefined();
  });

  test("enable rejects unknown rootIds", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    await expect(
      client.extensions.enable({ rootId: "missing", extensionId: "author.skill" })
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe("extensions IPC — project-local routing", () => {
  let env: TestExtensionRegistry;
  let projectPath: string;
  let projectRootId: string;
  let projectRoot: ExtensionRootDescriptor;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ext-ipc-proj-"));
    projectRootId = `project-local:${projectPath}`;
    projectRoot = {
      rootId: projectRootId,
      kind: "project-local",
      path: projectPath,
      trusted: true,
    };
    env = await createTestExtensionRegistry({
      roots: () => [projectRoot],
      discoverFn: stubDiscoverFn(({ roots }) => [
        makeRoot(
          roots[0],
          [
            makeExtension({
              extensionId: "author.skill",
              rootId: projectRootId,
              rootKind: "project-local",
              contributions: [{ type: "skills", id: "demo" }],
            }),
          ],
          true
        ),
      ]),
      now: () => FROZEN_NOW,
    });
    await env.projectState.setRootTrusted(projectPath, true);
    await env.registry.reload();
  });

  afterEach(async () => {
    await env.cleanup();
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  test("disable on a project-local root targets the project-local store, not global", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    await client.extensions.disable({ rootId: projectRootId, extensionId: "author.skill" });

    const projectState = await env.projectState.load(projectPath);
    expect(projectState.state.extensions["author.skill"]?.enabled).toBe(false);
    expect(env.globalState.load().state.extensions["author.skill"]).toBeUndefined();
  });

  test("approve on a project-local root persists to the project-local store", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    await client.extensions.approve({
      rootId: projectRootId,
      extensionId: "author.skill",
    });

    const projectState = await env.projectState.load(projectPath);
    const persisted = projectState.state.extensions["author.skill"]?.approval;
    expect(persisted).toMatchObject({
      grantedPermissions: SAMPLE_GRANT.grantedPermissions,
    });
    expect(persisted?.requestedPermissionsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("extensions IPC — forgetStale", () => {
  let env: TestExtensionRegistry;
  const userRoot: ExtensionRootDescriptor = {
    rootId: "user-global",
    kind: "user-global",
    path: "/fake/user-global",
  };

  beforeEach(async () => {
    env = await createTestExtensionRegistry({
      roots: () => [userRoot],
      // Stub returns no extensions, but we'll seed a global grant so the
      // record becomes stale.
      discoverFn: stubDiscoverFn(({ roots }) => [makeRoot(roots[0], [])]),
      now: () => FROZEN_NOW,
    });
    await env.globalState.setApproval("vanished.ext", SAMPLE_GRANT);
    await env.registry.reload();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  test("snapshot exposes a stale record with synthetic rootId", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    const snap = await client.extensions.list();
    expect(snap!.staleRecords).toHaveLength(1);
    expect(snap!.staleRecords[0]).toMatchObject({
      scope: "global",
      extensionId: "vanished.ext",
      rootId: "global",
    });
  });

  test("forgetStale targeted by { rootId, extensionId } removes the grant", async () => {
    const client = createRouterClient(router(), { context: makeContext(env) });
    await client.extensions.forgetStale({ rootId: "global", extensionId: "vanished.ext" });

    const snap = await client.extensions.list();
    expect(snap!.staleRecords).toEqual([]);
    expect(env.globalState.load().state.extensions["vanished.ext"]).toBeUndefined();
  });
});
