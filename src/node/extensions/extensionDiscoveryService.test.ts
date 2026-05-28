import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { mkdir, symlink, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  PER_FILE_TIMEOUT_MS_DEFAULT,
  PER_ROOT_TIMEOUT_MS_DEFAULT,
  discoverExtensions,
  type ExtensionRootDescriptor,
} from "./extensionDiscoveryService";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { QuickJSRuntime, QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { hashRequestedPermissions } from "@/common/extensions/permissionCalculator";
import type { ApprovalRecord } from "@/common/extensions/globalExtensionState";

const FROZEN_NOW = 1_700_000_000_000;

interface PackageOpts {
  name: string;
  version?: string;
  mux?: Record<string, unknown>;
}

async function writePackage(
  packagePath: string,
  opts: PackageOpts,
  files?: Record<string, string>
): Promise<void> {
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    path.join(packagePath, "package.json"),
    JSON.stringify(
      {
        name: opts.name,
        version: opts.version ?? "0.1.0",
        ...(opts.mux !== undefined ? { mux: opts.mux } : {}),
      },
      null,
      2
    )
  );
  if (files) {
    for (const [rel, content] of Object.entries(files)) {
      const filePath = path.join(packagePath, rel);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
  }
}

async function writeExtensionModule(
  rootPath: string,
  name: string,
  extensionTs: string,
  files?: Record<string, string>
): Promise<void> {
  const modulePath = path.join(rootPath, name);
  await mkdir(modulePath, { recursive: true });
  await writeFile(path.join(modulePath, "extension.ts"), extensionTs);
  if (files) {
    for (const [rel, content] of Object.entries(files)) {
      const filePath = path.join(modulePath, rel);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
  }
}

function extensionTs(name: string): string {
  return `
    import { defineManifest } from "mux:extensions";
    export const manifest = defineManifest({
      name: "${name}",
      displayName: "${name}",
      capabilities: { skills: true },
    });

    export function activate(ctx) {
      ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
    }
  `;
}

async function writeRootPackage(
  rootPath: string,
  dependencies: Record<string, string>
): Promise<void> {
  await mkdir(rootPath, { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "mux-extension-root", version: "0.0.0", dependencies }, null, 2)
  );
}

function rootDescriptor(
  partial: Partial<ExtensionRootDescriptor> & {
    rootId: string;
    kind: ExtensionRootDescriptor["kind"];
    path: string;
  }
): ExtensionRootDescriptor {
  return { ...partial };
}

const SAMPLE_GRANT: ApprovalRecord = {
  grantedPermissions: ["skill.register"],
  requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
};

describe("discoverExtensions — root existence", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-exists-"));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("missing root directory yields rootExists=false, state=ready, no diagnostics", async () => {
    const snapshot = await discoverExtensions({
      roots: [
        rootDescriptor({
          rootId: "user-global",
          kind: "user-global",
          path: path.join(tempDir, "does-not-exist"),
        }),
      ],
      now: FROZEN_NOW,
    });
    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.roots[0]).toMatchObject({
      rootExists: false,
      state: "ready",
      extensions: [],
      diagnostics: [],
    });
  });

  test("existing root with no package.json yields ready+empty (no candidates)", async () => {
    await mkdir(tempDir, { recursive: true });
    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });
    expect(snapshot.roots[0]).toMatchObject({
      rootExists: true,
      state: "ready",
      extensions: [],
      diagnostics: [],
    });
  });

  test("package.json-only Extension Roots are ignored", async () => {
    await writeRootPackage(tempDir, { "@legacy/package-extension": "0.1.0" });

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0]).toMatchObject({
      rootExists: true,
      state: "ready",
      extensions: [],
      diagnostics: [],
    });
  });
});

describe("discoverExtensions — Extension Modules", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-modules-"));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("trusted user-global root discovers direct child folders with extension.ts", async () => {
    await writeExtensionModule(tempDir, "acme-review", extensionTs("acme-review"));

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0].state).toBe("ready");
    expect(snapshot.roots[0].extensions).toHaveLength(1);
    expect(snapshot.roots[0].extensions[0]).toMatchObject({
      extensionId: "acme-review",
      manifest: { id: "acme-review" },
    });
  });

  test("Registration Discovery supports contained relative TypeScript imports", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        import { skillName } from "./helpers/skill";
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: skillName, bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "helpers/skill.ts": `export const skillName = "review";`,
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(true);
    expect(extension.contributions[0]).toMatchObject({
      type: "skills",
      id: "review",
      activated: true,
    });
  });

  test("Registration Discovery ignores require text in comments and strings", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        const note = 'example: require("child_process") is not executed';
        // require("fs") is documentation, not an import.
        export function activate(ctx) {
          if (!note) throw new Error("expected note");
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(true);
    expect(
      extension.diagnostics.some(
        (diagnostic) => diagnostic.code === "extension.discovery.import_unsupported"
      )
    ).toBe(false);
  });

  test("Registration Discovery rejects relative imports that escape the Extension Module", async () => {
    await writeFile(path.join(tempDir, "outside.ts"), `export const skillName = "review";`);
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        import { skillName } from "../outside";
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: skillName, bodyPath: "./skills/review/SKILL.md" });
        }
      `
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.contributions).toEqual([]);
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.discovery.failed" &&
          diagnostic.message.includes("outside the Extension Module")
      )
    ).toBe(true);
  });

  test("Registration Discovery rejects relative modules swapped to escaping symlinks before read", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        import { registerReview } from "./helper";
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          registerReview(ctx);
        }
      `,
      {
        "helper.ts":
          "export function registerReview(ctx) { throw new Error('inside helper should not execute'); }\n",
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );
    const helperPath = path.join(tempDir, "acme-review", "helper.ts");
    const outsideHelperPath = path.join(tempDir, "outside-helper.ts");
    await writeFile(
      outsideHelperPath,
      `export function registerReview(ctx) {
        ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
      }\n`
    );

    const originalStat = fsPromises.stat;
    const statSpy = spyOn(fsPromises, "stat");
    let swapped = false;
    statSpy.mockImplementation((async (target: Parameters<typeof fsPromises.stat>[0]) => {
      const result = await originalStat(target);
      if (!swapped && String(target) === helperPath) {
        swapped = true;
        await fsPromises.rm(helperPath, { force: true });
        await fsPromises.symlink(outsideHelperPath, helperPath);
      }
      return result;
    }) as unknown as typeof fsPromises.stat);

    try {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
        now: FROZEN_NOW,
      });

      const [extension] = snapshot.roots[0].extensions;
      expect(extension.contributions).toEqual([]);
      expect(
        extension.diagnostics.some(
          (diagnostic) => diagnostic.code === "extension.discovery.read_failed"
        )
      ).toBe(true);
    } finally {
      statSpy.mockRestore();
    }
  });

  test("Registration Discovery rejects relative modules swapped to directories before read", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        import { registerReview } from "./helper";
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          registerReview(ctx);
        }
      `,
      {
        "helper.ts":
          "export function registerReview(ctx) { throw new Error('inside helper should not execute'); }\n",
      }
    );
    const helperPath = path.join(tempDir, "acme-review", "helper.ts");

    const originalStat = fsPromises.stat;
    const statSpy = spyOn(fsPromises, "stat");
    let swapped = false;
    statSpy.mockImplementation((async (target: Parameters<typeof fsPromises.stat>[0]) => {
      const result = await originalStat(target);
      if (!swapped && String(target) === helperPath) {
        swapped = true;
        await fsPromises.rm(helperPath, { force: true });
        await fsPromises.mkdir(helperPath, { recursive: true });
      }
      return result;
    }) as unknown as typeof fsPromises.stat);

    try {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
        now: FROZEN_NOW,
      });

      const [extension] = snapshot.roots[0].extensions;
      expect(extension.contributions).toEqual([]);
      expect(
        extension.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "extension.discovery.read_failed" &&
            diagnostic.message.includes("regular file")
        )
      ).toBe(true);
    } finally {
      statSpy.mockRestore();
    }
  });

  test("Registration Discovery rejects oversized relative modules before reading", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        import { skillName } from "./huge";
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: skillName, bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "huge.ts": `export const skillName = "review";\n${"x".repeat(MAX_FILE_SIZE + 1)}`,
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.contributions).toEqual([]);
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.discovery.read_failed" &&
          diagnostic.message.includes("too large")
      )
    ).toBe(true);
  });

  test("Registration Discovery rejects npm and bare imports before execution", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        import leftPad from "left-pad";
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: leftPad("review", 6), bodyPath: "./skills/review/SKILL.md" });
        }
      `
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.contributions).toEqual([]);
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.discovery.import_unsupported" &&
          diagnostic.message.includes('"left-pad"')
      )
    ).toBe(true);
  });

  test("trusted modules run Registration Discovery and preview registered skills", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        import { defineManifest } from "mux:extensions";
        export const manifest = defineManifest({
          name: "acme-review",
          capabilities: { skills: true },
        });
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0].extensions).toHaveLength(1);
    const [extension] = snapshot.roots[0].extensions;
    expect(extension.contributions).toEqual([
      {
        type: "skills",
        id: "review",
        index: 0,
        bodyPath: "./skills/review/SKILL.md",
        activated: false,
      },
    ]);
    expect(extension.manifest.contributions[0]).toMatchObject({
      type: "skills",
      id: "review",
      descriptor: { id: "review", body: "./skills/review/SKILL.md" },
    });
  });

  test("Registration Discovery runtime startup failure is scoped to one extension", async () => {
    await writeExtensionModule(tempDir, "aaa-bad", extensionTs("aaa-bad"));
    await writeExtensionModule(tempDir, "zzz-good", extensionTs("zzz-good"));

    let createCalls = 0;
    const createSpy = spyOn(QuickJSRuntimeFactory.prototype, "create").mockImplementation(() => {
      createCalls++;
      if (createCalls === 1) return Promise.reject(new Error("quickjs unavailable"));
      return QuickJSRuntime.create();
    });

    try {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
        now: FROZEN_NOW,
      });

      const root = snapshot.roots[0];
      expect(root.state).toBe("ready");
      expect(root.extensions.map((extension) => extension.extensionId).sort()).toEqual([
        "aaa-bad",
        "zzz-good",
      ]);
      const failed = root.extensions.find((extension) => extension.extensionId === "aaa-bad");
      expect(
        failed?.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "extension.discovery.failed" &&
            diagnostic.message.includes("quickjs unavailable")
        )
      ).toBe(true);
      const healthy = root.extensions.find((extension) => extension.extensionId === "zzz-good");
      expect(healthy?.manifest.contributions.map((contribution) => contribution.id)).toEqual([
        "review",
      ]);
    } finally {
      createSpy.mockRestore();
    }
  });

  test("enabled and granted modules activate discovered skill bodies", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(true);
    expect(extension.contributions[0]).toMatchObject({
      type: "skills",
      id: "review",
      activated: true,
      bodyPath: "./skills/review/SKILL.md",
    });
    expect(extension.contributions[0].bodyRealPath).toBe(
      path.join(tempDir, "acme-review", "skills", "review", "SKILL.md")
    );
  });

  test("enabled registration-only modules activate without capability approval", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.granted).toBe(true);
    expect(extension.activated).toBe(true);
    expect(extension.contributions[0]).toMatchObject({
      type: "skills",
      id: "review",
      activated: true,
    });
  });

  test("Registration Discovery preserves static requested permissions", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
          requestedPermissions: ["network"],
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.manifest.requestedPermissions).toEqual(["network", "skill.register"]);
    expect(extension.activated).toBe(false);
  });

  test("Full Activation requires approval for requested effect permissions", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
          requestedPermissions: ["network"],
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
          if (ctx.mode === "activate") throw new Error("stale approval should not activate");
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );
    const staleApproval: ApprovalRecord = {
      grantedPermissions: [],
      requestedPermissionsHash: hashRequestedPermissions([]),
    };
    const incompleteApproval: ApprovalRecord = {
      grantedPermissions: [],
      requestedPermissionsHash: hashRequestedPermissions(["skill.register"]),
    };

    for (const approval of [staleApproval, incompleteApproval]) {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
        state: {
          isEnabled: () => true,
          getApprovalRecord: () => approval,
        },
        now: FROZEN_NOW,
      });

      const [extension] = snapshot.roots[0].extensions;
      expect(extension.granted).toBe(false);
      expect(extension.activated).toBe(false);
      expect(extension.contributions[0]).toMatchObject({
        type: "skills",
        id: "review",
        activated: false,
      });
      expect(
        extension.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "extension.activation.failed" &&
            diagnostic.message.includes("stale approval should not activate")
        )
      ).toBe(false);
    }
  });

  test("Full Activation skips activation-only registrations that requested no permissions", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          if (ctx.mode === "discover") return;
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
          throw new Error("activation-only code should not run");
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );
    const emptyApproval: ApprovalRecord = {
      grantedPermissions: [],
      requestedPermissionsHash: hashRequestedPermissions([]),
    };

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => emptyApproval,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.manifest.requestedPermissions).toEqual([]);
    expect(extension.manifest.contributions).toEqual([]);
    expect(extension.activated).toBe(false);
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.activation.failed" &&
          diagnostic.message.includes("activation-only code should not run")
      )
    ).toBe(false);
  });

  test("Activation Discovery awaits async activate before publishing discovered skill bodies", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export async function activate(ctx) {
          await Promise.resolve();
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(true);
    expect(extension.contributions[0]).toMatchObject({
      type: "skills",
      id: "review",
      activated: true,
      bodyPath: "./skills/review/SKILL.md",
    });
  });

  test("Full Activation runs in a fresh sandbox separate from Registration Discovery", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        let activationRuns = 0;
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          activationRuns += 1;
          if (ctx.mode === "discover") {
            ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
            return;
          }
          if (activationRuns === 1) {
            ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
          }
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(true);
    expect(extension.contributions[0]).toMatchObject({
      type: "skills",
      id: "review",
      activated: true,
    });
  });

  test("Full Activation honors disposed skill registrations without treating discovery as disposed", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          const registration = ctx.skills.register({
            name: "review",
            bodyPath: "./skills/review/SKILL.md",
          });
          if (ctx.mode === "activate") registration.dispose();
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.manifest.contributions).toHaveLength(1);
    expect(extension.activated).toBe(true);
    expect(extension.contributions).toEqual([
      {
        type: "skills",
        id: "review",
        index: 0,
        bodyPath: "./skills/review/SKILL.md",
        activated: false,
      },
    ]);
  });

  test("activation rejects SKILL.md frontmatter names that do not match the registered skill", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: other\ndescription: Wrong name\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(false);
    expect(extension.contributions[0].activated).toBe(false);
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "contribution.body.invalid" &&
          diagnostic.message.includes("frontmatter.name")
      )
    ).toBe(true);
  });

  test("activation does not validate a skill body after it is swapped to an escaping symlink", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: other\ndescription: Wrong name\n---\n# Review\n",
      }
    );
    const bodyPath = path.join(tempDir, "acme-review", "skills", "review", "SKILL.md");
    const outsidePath = path.join(tempDir, "outside.md");
    await writeFile(
      outsidePath,
      "---\nname: review\ndescription: Outside helper\n---\noutside secret"
    );

    const originalStat = fsPromises.stat;
    const statSpy = spyOn(fsPromises, "stat");
    statSpy.mockImplementation((async (target: Parameters<typeof fsPromises.stat>[0]) => {
      const result = await originalStat(target);
      if (String(target) === bodyPath) {
        await fsPromises.rm(bodyPath, { force: true });
        await fsPromises.symlink(outsidePath, bodyPath);
      }
      return result;
    }) as unknown as typeof fsPromises.stat);

    const originalOpen = fsPromises.open;
    const openSpy = spyOn(fsPromises, "open");
    openSpy.mockImplementation(((
      target: Parameters<typeof fsPromises.open>[0],
      flags?: Parameters<typeof fsPromises.open>[1],
      mode?: Parameters<typeof fsPromises.open>[2]
    ) =>
      originalOpen(
        String(target) === bodyPath ? outsidePath : target,
        flags,
        mode
      )) as typeof fsPromises.open);

    try {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
        state: {
          isEnabled: () => true,
          getApprovalRecord: () => SAMPLE_GRANT,
        },
        now: FROZEN_NOW,
      });

      const [extension] = snapshot.roots[0].extensions;
      expect(extension.activated).toBe(false);
      expect(extension.contributions[0].activated).toBe(false);
      expect(
        extension.diagnostics.some((diagnostic) => diagnostic.code === "contribution.body.invalid")
      ).toBe(true);
    } finally {
      openSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  test("Full Activation failures use activation diagnostics without dropping discovery preview", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
          if (ctx.mode === "activate") throw new Error("activation exploded");
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.manifest.contributions).toHaveLength(1);
    expect(extension.activated).toBe(false);
    expect(extension.contributions[0]).toMatchObject({
      type: "skills",
      id: "review",
      activated: false,
    });
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.activation.failed" &&
          diagnostic.message.includes("activation exploded")
      )
    ).toBe(true);
    expect(
      extension.diagnostics.some((diagnostic) => diagnostic.code === "extension.discovery.failed")
    ).toBe(false);
  });

  test("Full Activation console output does not prevent publishing discovered skills", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          if (ctx.mode === "activate") console.warn("activation warning");
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(true);
    expect(extension.contributions[0].activated).toBe(true);
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.activation.console" &&
          diagnostic.message.includes("activation warning")
      )
    ).toBe(true);
  });

  test("Full Activation rejects skills that were not observed during Registration Discovery", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          if (ctx.mode === "discover") {
            ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
            return;
          }
          ctx.skills.register({ name: "surprise", bodyPath: "./skills/surprise/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
        "skills/surprise/SKILL.md":
          "---\nname: surprise\ndescription: Surprise helper\n---\n# Surprise\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(false);
    expect(extension.contributions).toEqual([
      {
        type: "skills",
        id: "review",
        index: 0,
        bodyPath: "./skills/review/SKILL.md",
        activated: false,
      },
    ]);
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.activation.undiscovered" &&
          diagnostic.message.includes("surprise")
      )
    ).toBe(true);
  });

  test("Full Activation accepts the same discovered skill after normalizing bodyPath", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          if (ctx.mode === "discover") {
            ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
            return;
          }
          ctx.skills.register({ name: "review", bodyPath: "skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(true);
    expect(extension.contributions).toEqual([
      {
        type: "skills",
        id: "review",
        index: 0,
        bodyPath: "./skills/review/SKILL.md",
        bodyRealPath: path.join(tempDir, "acme-review", "skills", "review", "SKILL.md"),
        activated: true,
      },
    ]);
    expect(
      extension.diagnostics.some(
        (diagnostic) => diagnostic.code === "extension.activation.undiscovered"
      )
    ).toBe(false);
  });

  test("Registration Discovery surfaces sandbox console output as diagnostics", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          if (ctx.mode === "discover") {
            console.log("discovering", ctx.mode);
            console.warn("watch", { count: 1 });
            console.error("problem");
          }
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(
      extension.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
      }))
    ).toEqual([
      {
        code: "extension.discovery.console",
        severity: "info",
        message: "Registration Discovery console.log: discovering discover",
      },
      {
        code: "extension.discovery.console",
        severity: "warn",
        message: 'Registration Discovery console.warn: watch {"count":1}',
      },
      {
        code: "extension.discovery.console",
        severity: "error",
        message: "Registration Discovery console.error: problem",
      },
    ]);
  });

  test("Registration Discovery rejects skill registration without manifest capabilities.skills", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = { name: "acme-review" };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0].extensions).toHaveLength(1);
    const [extension] = snapshot.roots[0].extensions;
    expect(extension.contributions).toEqual([]);
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.capability.undeclared" &&
          diagnostic.severity === "error" &&
          diagnostic.extensionId === "acme-review"
      )
    ).toBe(true);
  });

  test("Registration Discovery and Full Activation expose only skills registration APIs", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };

        function assertNoDangerousEffectApis(ctx) {
          const ctxKeys = Object.keys(ctx).sort().join(",");
          const skillKeys = Object.keys(ctx.skills).sort().join(",");
          if (ctxKeys !== "mode,skills") throw new Error("unexpected ctx keys: " + ctxKeys);
          if (skillKeys !== "register") throw new Error("unexpected skills keys: " + skillKeys);

          const exposed = [];
          for (const name of ["fs", "process", "secrets", "fetch"]) {
            if (typeof ctx[name] !== "undefined") exposed.push("ctx." + name);
          }
          for (const name of ["fetch", "process", "require", "Bun", "Deno"]) {
            if (typeof globalThis[name] !== "undefined") exposed.push("globalThis." + name);
          }
          if (exposed.length > 0) {
            throw new Error("dangerous effect API exposed: " + exposed.join(","));
          }
        }

        export function activate(ctx) {
          assertNoDangerousEffectApis(ctx);
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const [extension] = snapshot.roots[0].extensions;
    expect(extension.activated).toBe(true);
    expect(extension.contributions[0]).toMatchObject({
      type: "skills",
      id: "review",
      activated: true,
    });
    expect(
      extension.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.discovery.failed" ||
          diagnostic.code === "extension.activation.failed"
      )
    ).toBe(false);
  });

  test("manifest.name must match the module folder basename", async () => {
    await writeExtensionModule(tempDir, "acme-review", extensionTs("other-review"));

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0].extensions).toEqual([]);
    expect(
      snapshot.roots[0].diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.name.mismatch" && diagnostic.severity === "error"
      )
    ).toBe(true);
  });

  test("invalid module folder names are diagnosed", async () => {
    await writeExtensionModule(tempDir, "Acme_Review", extensionTs("acme-review"));

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0].extensions).toEqual([]);
    expect(
      snapshot.roots[0].diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extension.name.invalid" && diagnostic.extensionId === "Acme_Review"
      )
    ).toBe(true);
  });

  test("untrusted project-local module root does not read extension.ts", async () => {
    await writeExtensionModule(tempDir, "acme-review", extensionTs("acme-review"));
    const readSpy = spyOn(fsPromises, "readFile");

    try {
      const snapshot = await discoverExtensions({
        roots: [
          rootDescriptor({
            rootId: "project-local",
            kind: "project-local",
            path: tempDir,
            trusted: false,
          }),
        ],
        now: FROZEN_NOW,
      });

      expect(snapshot.roots[0]).toMatchObject({
        rootExists: true,
        trusted: false,
        extensions: [],
        diagnostics: [],
      });
      const reads = readSpy.mock.calls.filter((args) => {
        const target = args[0];
        return typeof target === "string" && target.startsWith(tempDir);
      });
      expect(reads).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("non-static module manifests are rejected without crashing discovery", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `const name = "acme-review"; export const manifest = defineManifest({ name });`
    );

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0].extensions).toEqual([]);
    expect(
      snapshot.roots[0].diagnostics.some(
        (diagnostic) => diagnostic.code === "manifest.static.unsupported"
      )
    ).toBe(true);
  });
});

describe("discoverExtensions — pre-trust project-local existence-only", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-pretrust-"));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("untrusted project-local root with package.json present is NOT read (verified via spyOn)", async () => {
    await writeRootPackage(tempDir, { "@author/skill": "0.1.0" });
    const pkgPath = path.join(tempDir, "node_modules", "@author", "skill");
    await writePackage(pkgPath, {
      name: "@author/skill",
      mux: {
        manifestVersion: 1,
        id: "author.skill",
        contributes: { skills: [{ id: "demo", body: "SKILL.md" }] },
      },
    });

    // Spy on the filesystem read used by manifest inspection. The pre-trust
    // gate must skip this read entirely; only the existence stat is allowed.
    const readSpy = spyOn(fsPromises, "readFile");

    try {
      const snapshot = await discoverExtensions({
        roots: [
          rootDescriptor({
            rootId: "project-local",
            kind: "project-local",
            path: tempDir,
            trusted: false,
          }),
        ],
        now: FROZEN_NOW,
      });

      expect(snapshot.roots[0]).toMatchObject({
        rootExists: true,
        trusted: false,
        state: "ready",
        extensions: [],
        diagnostics: [],
      });
      const reads = readSpy.mock.calls.filter((args) => {
        const target = args[0];
        return typeof target === "string" && target.startsWith(tempDir);
      });
      expect(reads).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("trusted project-local root discovers Extension Modules", async () => {
    await writeExtensionModule(tempDir, "author-skill", extensionTs("author-skill"));

    const snapshot = await discoverExtensions({
      roots: [
        rootDescriptor({
          rootId: "project-local",
          kind: "project-local",
          path: tempDir,
          trusted: true,
        }),
      ],
      now: FROZEN_NOW,
    });
    expect(snapshot.roots[0].state).toBe("ready");
    expect(snapshot.roots[0].extensions).toHaveLength(1);
    expect(snapshot.roots[0].extensions[0].extensionId).toBe("author-skill");
  });
});

describe("discoverExtensions — bundled root with demo extension", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-bundled-"));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function writeBundledDemoModule(extensionsDir: string): Promise<void> {
    await writeExtensionModule(
      extensionsDir,
      "mux-platform-demo",
      `
        export const manifest = {
          name: "mux-platform-demo",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "mux-extensions", bodyPath: "./SKILL.md" });
        }
      `,
      {
        "SKILL.md":
          "---\nname: mux-extensions\ndescription: Mux extensions demo\n---\n# mux-extensions skill body",
      }
    );
  }

  test("bundled root with mux-platform-demo discovers the demo skill", async () => {
    const extensionsDir = path.join(tempDir, "extensions");
    await writeBundledDemoModule(extensionsDir);

    const snapshot = await discoverExtensions({
      roots: [
        rootDescriptor({
          rootId: "bundled",
          kind: "bundled",
          path: extensionsDir,
          isCore: true,
        }),
      ],
      now: FROZEN_NOW,
    });

    const root = snapshot.roots[0];
    expect(root.state).toBe("ready");
    expect(root.trusted).toBe(true);
    expect(root.extensions).toHaveLength(1);
    const ext = root.extensions[0];
    expect(ext).toMatchObject({
      extensionId: "mux-platform-demo",
      isCore: true,
      enabled: true,
    });
    expect(ext.contributions).toHaveLength(1);
    expect(ext.contributions[0]).toMatchObject({
      type: "skills",
      id: "mux-extensions",
      bodyPath: "./SKILL.md",
    });
    // Bundled Extensions are policy-granted, so the Demo Extension activates
    // on a fresh install with no persisted approval record.
    expect(ext.granted).toBe(true);
    expect(ext.activated).toBe(true);
    expect(ext.contributions[0].activated).toBe(true);
  });

  test("bundled root with grant runs Activation Discovery and reads SKILL.md", async () => {
    const extensionsDir = path.join(tempDir, "extensions");
    await writeBundledDemoModule(extensionsDir);

    const snapshot = await discoverExtensions({
      roots: [
        rootDescriptor({
          rootId: "bundled",
          kind: "bundled",
          path: extensionsDir,
          isCore: true,
        }),
      ],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const ext = snapshot.roots[0].extensions[0];
    expect(ext.granted).toBe(true);
    expect(ext.activated).toBe(true);
    expect(ext.contributions[0].activated).toBe(true);
  });
});

describe("discoverExtensions — failure modes", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-fail-"));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("malformed static manifest yields error diagnostics; other Extension Modules in the root still discovered", async () => {
    await writeExtensionModule(
      tempDir,
      "bad-module",
      `export const manifest = { name: "wrong-name", capabilities: { skills: true } };`
    );
    await writeExtensionModule(tempDir, "good-module", extensionTs("good-module"));

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "ug", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });
    const root = snapshot.roots[0];
    expect(root.state).toBe("ready");
    const ids = root.extensions.map((e) => e.extensionId);
    expect(ids).toEqual(["good-module"]);
    const codes = root.diagnostics.map((d) => d.code);
    expect(codes).toContain("extension.name.mismatch");
  });

  test("symlinked Extension Module folders cannot resolve outside the Extension Root", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-outside-module-"));
    try {
      await writeExtensionModule(outsideDir, "acme-review", extensionTs("acme-review"), {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Outside helper\n---\n# Review\n",
      });
      await symlink(path.join(outsideDir, "acme-review"), path.join(tempDir, "acme-review"), "dir");

      const snapshot = await discoverExtensions({
        roots: [
          rootDescriptor({
            rootId: "project-local:/repo",
            kind: "project-local",
            path: tempDir,
            trusted: true,
          }),
        ],
        now: FROZEN_NOW,
      });

      expect(snapshot.roots[0].extensions).toEqual([]);
      expect(snapshot.roots[0].diagnostics).toHaveLength(1);
      expect(snapshot.roots[0].diagnostics[0]).toMatchObject({
        code: "extension.module.outside_root",
        extensionId: "acme-review",
      });
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("symlinked extension.ts files cannot resolve outside the Extension Module", async () => {
    const outsideEntrypoint = path.join(tempDir, "outside-extension.ts");
    await mkdir(path.join(tempDir, "acme-review"), { recursive: true });
    await writeFile(
      outsideEntrypoint,
      `export const manifest = { name: "acme-review", capabilities: { skills: true } };
       export function activate(ctx) {
         ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
       }
      `
    );
    await symlink(outsideEntrypoint, path.join(tempDir, "acme-review", "extension.ts"));

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "ug", kind: "user-global", path: tempDir })],
      now: FROZEN_NOW,
    });

    const root = snapshot.roots[0];
    expect(root.extensions).toEqual([]);
    expect(root.diagnostics).toHaveLength(1);
    expect(root.diagnostics[0]).toMatchObject({
      code: "extension.entrypoint.invalid",
      extensionId: "acme-review",
      severity: "error",
    });
  });

  test("extension.ts swapped to a directory before open is rejected", async () => {
    await writeExtensionModule(tempDir, "acme-review", extensionTs("acme-review"));
    const entrypointPath = path.join(tempDir, "acme-review", "extension.ts");

    const originalOpen = fsPromises.open;
    const openSpy = spyOn(fsPromises, "open");
    let swapped = false;
    openSpy.mockImplementation((async (
      target: Parameters<typeof fsPromises.open>[0],
      flags?: Parameters<typeof fsPromises.open>[1],
      mode?: Parameters<typeof fsPromises.open>[2]
    ) => {
      if (!swapped && String(target) === entrypointPath) {
        swapped = true;
        await fsPromises.rm(entrypointPath, { force: true });
        await fsPromises.mkdir(entrypointPath, { recursive: true });
      }
      return originalOpen(target, flags, mode);
    }) as typeof fsPromises.open);

    try {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "ug", kind: "user-global", path: tempDir })],
        now: FROZEN_NOW,
      });

      expect(snapshot.roots[0].extensions).toEqual([]);
      expect(snapshot.roots[0].diagnostics).toHaveLength(1);
      expect(snapshot.roots[0].diagnostics[0]).toMatchObject({
        code: "extension.entrypoint.invalid",
        extensionId: "acme-review",
      });
    } finally {
      openSpy.mockRestore();
    }
  });

  test("symlinked Contributed Path is rejected at activation", async () => {
    const outside = path.join(tempDir, "outside.md");
    await mkdir(tempDir, { recursive: true });
    await writeFile(outside, "outside content");
    await writeExtensionModule(tempDir, "author-sym", extensionTs("author-sym"));
    await mkdir(path.join(tempDir, "author-sym", "skills", "review"), { recursive: true });
    await symlink(outside, path.join(tempDir, "author-sym", "skills", "review", "SKILL.md"));

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "ug", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const root = snapshot.roots[0];
    expect(root.state).toBe("ready");
    const ext = root.extensions[0];
    expect(ext.activated).toBe(false);
    expect(ext.contributions[0].activated).toBe(false);
    const symlinkDiag = ext.diagnostics.find((d) => d.code === "contribution.body.invalid");
    expect(symlinkDiag).toBeDefined();
    expect(symlinkDiag?.contributionRef).toMatchObject({ type: "skills", id: "review" });
  });

  test("non-regular Contributed Path is rejected before opening body", async () => {
    await writeExtensionModule(
      tempDir,
      "author-dir",
      `
        export const manifest = {
          name: "author-dir",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review" });
        }
      `
    );
    const bodyDir = path.join(tempDir, "author-dir", "skills", "review");
    await mkdir(bodyDir, { recursive: true });

    const originalOpen = fsPromises.open;
    const openSpy = spyOn(fsPromises, "open");
    let openedBodyDir = false;
    openSpy.mockImplementation(((
      target: Parameters<typeof fsPromises.open>[0],
      flags?: Parameters<typeof fsPromises.open>[1],
      mode?: Parameters<typeof fsPromises.open>[2]
    ) => {
      if (String(target) === bodyDir) openedBodyDir = true;
      return originalOpen(target, flags, mode);
    }) as typeof fsPromises.open);

    try {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "ug", kind: "user-global", path: tempDir })],
        state: {
          isEnabled: () => true,
          getApprovalRecord: () => SAMPLE_GRANT,
        },
        now: FROZEN_NOW,
      });

      const ext = snapshot.roots[0].extensions[0];
      expect(ext.activated).toBe(false);
      expect(ext.contributions[0].activated).toBe(false);
      expect(openedBodyDir).toBe(false);
      const bodyDiag = ext.diagnostics.find((d) => d.code === "contribution.body.invalid");
      expect(bodyDiag?.message).toContain("regular file");
    } finally {
      openSpy.mockRestore();
    }
  });

  test("oversized Contributed Path is rejected before body read", async () => {
    await writeExtensionModule(tempDir, "author-big", extensionTs("author-big"), {
      "skills/review/SKILL.md": "x".repeat(MAX_FILE_SIZE + 1),
    });

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "ug", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      now: FROZEN_NOW,
    });

    const ext = snapshot.roots[0].extensions[0];
    expect(ext.activated).toBe(false);
    expect(ext.contributions[0].activated).toBe(false);
    const sizeDiag = ext.diagnostics.find((d) => d.code === "contribution.body.invalid");
    expect(sizeDiag?.message).toContain("File is too large");
  });

  test("per-root timeout suppresses late activation session publication", async () => {
    await writeExtensionModule(
      tempDir,
      "acme-review",
      `
        export const manifest = {
          name: "acme-review",
          capabilities: { skills: true },
        };
        export function activate(ctx) {
          ctx.skills.register({ name: "review", bodyPath: "./skills/review/SKILL.md" });
        }
      `,
      {
        "skills/review/SKILL.md": "---\nname: review\ndescription: Review helper\n---\n# Review\n",
      }
    );
    const lateSessions: unknown[] = [];

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "user-global", kind: "user-global", path: tempDir })],
      state: {
        isEnabled: () => true,
        getApprovalRecord: () => SAMPLE_GRANT,
      },
      perRootTimeoutMs: 1,
      now: FROZEN_NOW,
      activationSessionSink: (record) => lateSessions.push(record),
    });

    expect(snapshot.roots[0]).toMatchObject({ state: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(lateSessions).toHaveLength(0);
  });

  test("per-root timeout produces failed state with root.discovery.timeout error", async () => {
    await writeExtensionModule(tempDir, "author-foo", extensionTs("author-foo"));

    const snapshot = await discoverExtensions({
      roots: [rootDescriptor({ rootId: "ug", kind: "user-global", path: tempDir })],
      perRootTimeoutMs: 0, // immediate timeout
      now: FROZEN_NOW,
    });
    const root = snapshot.roots[0];
    expect(root.state).toBe("failed");
    const codes = root.diagnostics.map((d) => d.code);
    expect(codes).toContain("root.discovery.timeout");
    expect(root.extensions).toEqual([]);
  });
});

describe("discoverExtensions — root isolation", () => {
  let bundledTmp: string;
  let userTmp: string;
  beforeEach(() => {
    bundledTmp = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-iso-bundled-"));
    userTmp = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-iso-user-"));
  });
  afterEach(() => {
    fs.rmSync(bundledTmp, { recursive: true, force: true });
    fs.rmSync(userTmp, { recursive: true, force: true });
  });

  test("unreadable root becomes failed without dropping healthy roots", async () => {
    const blockedRoot = bundledTmp;
    const healthyRoot = userTmp;
    await writeExtensionModule(healthyRoot, "author-good", extensionTs("author-good"));

    const realStat: (filePath: Parameters<typeof fsPromises.stat>[0]) => Promise<fs.Stats> =
      fsPromises.stat;
    const mockStat = (async (filePath: Parameters<typeof fsPromises.stat>[0]) => {
      if (filePath.toString() === blockedRoot) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        return Promise.reject(error);
      }
      return realStat(filePath);
    }) as typeof fsPromises.stat;
    const statSpy = spyOn(fsPromises, "stat").mockImplementation(mockStat);

    try {
      const snapshot = await discoverExtensions({
        roots: [
          rootDescriptor({ rootId: "blocked", kind: "user-global", path: blockedRoot }),
          rootDescriptor({ rootId: "healthy", kind: "user-global", path: healthyRoot }),
        ],
        now: FROZEN_NOW,
      });

      expect(snapshot.roots[0].state).toBe("failed");
      expect(snapshot.roots[0].diagnostics[0]?.code).toBe("root.access.failed");
      expect(snapshot.roots[1].extensions.map((ext) => ext.extensionId)).toEqual(["author-good"]);
    } finally {
      statSpy.mockRestore();
    }
  });

  test("entrypoint stat failure is diagnosed without dropping healthy modules", async () => {
    await writeExtensionModule(bundledTmp, "author-bad", extensionTs("author-bad"));
    await writeExtensionModule(bundledTmp, "author-good", extensionTs("author-good"));
    const badEntrypointPath = path.join(bundledTmp, "author-bad", "extension.ts");

    const realStat = fsPromises.stat;
    const statSpy = spyOn(fsPromises, "stat").mockImplementation(((
      target: Parameters<typeof fsPromises.stat>[0]
    ) => {
      if (String(target) === badEntrypointPath) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        return Promise.reject(error);
      }
      return realStat(target);
    }) as typeof fsPromises.stat);

    try {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "bundled", kind: "bundled", path: bundledTmp })],
        now: FROZEN_NOW,
      });

      const root = snapshot.roots[0];
      expect(root.state).toBe("ready");
      expect(root.extensions.map((extension) => extension.extensionId)).toEqual(["author-good"]);
      expect(root.diagnostics[0]).toMatchObject({
        code: "extension.entrypoint.read_failed",
        extensionId: "author-bad",
        severity: "error",
      });
      expect(root.diagnostics[0]?.message).toContain("permission denied");
    } finally {
      statSpy.mockRestore();
    }
  });

  test("module inspection failure is diagnosed without dropping healthy modules", async () => {
    await writeExtensionModule(bundledTmp, "author-bad", extensionTs("author-bad"));
    await writeExtensionModule(bundledTmp, "author-good", extensionTs("author-good"));
    const badModulePath = path.join(bundledTmp, "author-bad");

    const realRealpath = fsPromises.realpath;
    const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation(((
      target: Parameters<typeof fsPromises.realpath>[0]
    ) => {
      if (String(target) === badModulePath) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        return Promise.reject(error);
      }
      return realRealpath(target);
    }) as typeof fsPromises.realpath);

    try {
      const snapshot = await discoverExtensions({
        roots: [rootDescriptor({ rootId: "bundled", kind: "bundled", path: bundledTmp })],
        now: FROZEN_NOW,
      });

      const root = snapshot.roots[0];
      expect(root.state).toBe("ready");
      expect(root.extensions.map((extension) => extension.extensionId)).toEqual(["author-good"]);
      expect(root.diagnostics[0]).toMatchObject({
        code: "extension.module.read_failed",
        extensionId: "author-bad",
        severity: "error",
      });
      expect(root.diagnostics[0]?.message).toContain("permission denied");
    } finally {
      realpathSpy.mockRestore();
    }
  });

  test("root realpath failure becomes a failed root without dropping healthy roots", async () => {
    const blockedRoot = bundledTmp;
    const healthyRoot = userTmp;
    await writeExtensionModule(blockedRoot, "author-blocked", extensionTs("author-blocked"));
    await writeExtensionModule(healthyRoot, "author-good", extensionTs("author-good"));

    const realRealpath = fsPromises.realpath;
    const realpathSpy = spyOn(fsPromises, "realpath").mockImplementation(((
      target: Parameters<typeof fsPromises.realpath>[0]
    ) => {
      if (String(target) === blockedRoot) {
        return Promise.reject(new Error("root disappeared"));
      }
      return realRealpath(target);
    }) as typeof fsPromises.realpath);

    try {
      const snapshot = await discoverExtensions({
        roots: [
          rootDescriptor({ rootId: "blocked", kind: "user-global", path: blockedRoot }),
          rootDescriptor({ rootId: "healthy", kind: "user-global", path: healthyRoot }),
        ],
        now: FROZEN_NOW,
      });

      expect(snapshot.roots[0].state).toBe("failed");
      expect(snapshot.roots[0].diagnostics[0]?.code).toBe("root.read.failed");
      expect(snapshot.roots[0].diagnostics[0]?.message).toContain("root disappeared");
      expect(snapshot.roots[1].extensions.map((ext) => ext.extensionId)).toEqual(["author-good"]);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  test("a failed root contributes no Extensions but does not affect other roots", async () => {
    await writeExtensionModule(bundledTmp, "mux-demo", extensionTs("mux-demo"));

    // User-global: path exists but is not a directory, so readdir fails.
    await fsPromises.rm(userTmp, { recursive: true, force: true });
    await writeFile(userTmp, "not a directory");

    const snapshot = await discoverExtensions({
      roots: [
        rootDescriptor({ rootId: "bundled", kind: "bundled", path: bundledTmp }),
        rootDescriptor({ rootId: "user-global", kind: "user-global", path: userTmp }),
      ],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0].state).toBe("ready");
    expect(snapshot.roots[0].extensions).toHaveLength(1);
    expect(snapshot.roots[1].state).toBe("failed");
    expect(snapshot.roots[1].diagnostics.some((d) => d.code === "root.read.failed")).toBe(true);
  });

  test("bundled root + failed user-global root keeps bundled extensions", async () => {
    await writeExtensionModule(bundledTmp, "mux-demo", extensionTs("mux-demo"));

    await fsPromises.rm(userTmp, { recursive: true, force: true });
    await writeFile(userTmp, "not a directory");

    const snapshot = await discoverExtensions({
      roots: [
        rootDescriptor({ rootId: "bundled", kind: "bundled", path: bundledTmp }),
        rootDescriptor({ rootId: "user-global", kind: "user-global", path: userTmp }),
      ],
      now: FROZEN_NOW,
    });

    expect(snapshot.roots[0].state).toBe("ready");
    expect(snapshot.roots[0].extensions).toHaveLength(1);
    expect(snapshot.roots[0].extensions[0].extensionId).toBe("mux-demo");

    expect(snapshot.roots[1].state).toBe("failed");
    expect(snapshot.roots[1].diagnostics.some((d) => d.code === "root.read.failed")).toBe(true);
  });
});

describe("discoverExtensions — defaults & shape", () => {
  test("default per-root timeout is 10s and per-file timeout is 5s", () => {
    expect(PER_ROOT_TIMEOUT_MS_DEFAULT).toBe(10_000);
    expect(PER_FILE_TIMEOUT_MS_DEFAULT).toBe(5_000);
  });

  test("snapshot includes generatedAt = now() override and preserves root order", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-discovery-shape-"));
    try {
      const snapshot = await discoverExtensions({
        roots: [
          rootDescriptor({
            rootId: "missing-1",
            kind: "user-global",
            path: path.join(tempDir, "missing-1"),
          }),
          rootDescriptor({
            rootId: "missing-2",
            kind: "project-local",
            path: path.join(tempDir, "missing-2"),
          }),
        ],
        now: FROZEN_NOW,
      });
      expect(snapshot.generatedAt).toBe(FROZEN_NOW);
      expect(snapshot.roots.map((r) => r.rootId)).toEqual(["missing-1", "missing-2"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
