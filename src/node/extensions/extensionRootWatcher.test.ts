import { EventEmitter } from "events";
import * as fs from "fs";
import { mkdir, symlink, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ExtensionRootWatcher, type WatchFn } from "./extensionRootWatcher";
import type { ExtensionRootDescriptor } from "./extensionDiscoveryService";

const noOp = (): void => undefined;

class FakeFSWatcher extends EventEmitter {
  closed = false;
  constructor(public readonly watchedPath: string) {
    super();
  }
  close(): void {
    this.closed = true;
    this.removeAllListeners();
  }
  emitChange(filename: string | null): void {
    this.emit("change", "change", filename);
  }
  emitError(err: Error): void {
    this.emit("error", err);
  }
}

interface FakeWatchHarness {
  watchFn: WatchFn;
  watchers: FakeFSWatcher[];
  failPaths: Set<string>;
}

function createFakeWatch(): FakeWatchHarness {
  const watchers: FakeFSWatcher[] = [];
  const failPaths = new Set<string>();

  const watchFn: WatchFn = (target, _opts, listener) => {
    if (failPaths.has(String(target))) {
      throw new Error(`fs.watch failed for ${String(target)}`);
    }
    const watcher = new FakeFSWatcher(String(target));
    if (listener) watcher.on("change", listener);
    watchers.push(watcher);
    return watcher as unknown as fs.FSWatcher;
  };

  return { watchFn, watchers, failPaths };
}

const bundledRoot: ExtensionRootDescriptor = {
  rootId: "bundled",
  kind: "bundled",
  path: "/fake/bundled",
  isCore: true,
};

const userGlobalRoot: ExtensionRootDescriptor = {
  rootId: "user-global",
  kind: "user-global",
  path: "/fake/user-global",
};

function projectRoot(opts: { trusted: boolean; suffix?: string }): ExtensionRootDescriptor {
  return {
    rootId: `project-local${opts.suffix ?? ""}`,
    kind: "project-local",
    path: `/fake/project${opts.suffix ?? ""}`,
    trusted: opts.trusted,
  };
}

const silentLog = { debug: noOp };

describe("ExtensionRootWatcher — eligibility", () => {
  test("does not watch bundled roots", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    await watcher.setRoots([bundledRoot]);
    expect(harness.watchers).toHaveLength(0);
  });

  test("watches user-global root unconditionally", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    await watcher.setRoots([userGlobalRoot]);
    expect(harness.watchers).toHaveLength(1);
    expect(harness.watchers[0].watchedPath).toBe(userGlobalRoot.path);
  });

  test("does not watch untrusted project-local roots", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    await watcher.setRoots([projectRoot({ trusted: false })]);
    expect(harness.watchers).toHaveLength(0);
  });

  test("watches trusted project-local roots", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    await watcher.setRoots([projectRoot({ trusted: true })]);
    expect(harness.watchers).toHaveLength(1);
  });
});

describe("ExtensionRootWatcher — Extension Modules", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `mux-root-watcher-modules-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(path.join(tempDir, "acme-review"), { recursive: true });
    await writeFile(
      path.join(tempDir, "acme-review", "extension.ts"),
      "export const manifest = {};"
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test("watches direct Extension Module folders that contain extension.ts", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);

    expect(harness.watchers.map((fake) => fake.watchedPath).sort()).toEqual(
      [path.join(tempDir, "acme-review"), tempDir].sort()
    );
  });

  test("does not watch unrelated nested directories inside Extension Modules", async () => {
    await mkdir(path.join(tempDir, "acme-review", "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(tempDir, "acme-review", "node_modules", "pkg", "index.js"), "");
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);

    expect(harness.watchers.map((fake) => fake.watchedPath)).not.toContain(
      path.join(tempDir, "acme-review", "node_modules")
    );
    expect(harness.watchers.map((fake) => fake.watchedPath)).not.toContain(
      path.join(tempDir, "acme-review", "node_modules", "pkg")
    );
  });

  test("does not watch symlinked Extension Module folders that resolve outside the root", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-root-watcher-outside-"));
    try {
      await writeFile(path.join(outsideDir, "extension.ts"), "export const manifest = {};\n");
      await mkdir(path.join(outsideDir, "src"), { recursive: true });
      await writeFile(path.join(outsideDir, "src", "register.ts"), "export {};\n");
      await symlink(outsideDir, path.join(tempDir, "linked-review"), "dir");
      const harness = createFakeWatch();
      using watcher = new ExtensionRootWatcher({
        onChange: noOp,
        watchFn: harness.watchFn,
        log: silentLog,
      });

      await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);

      expect(harness.watchers.map((fake) => fake.watchedPath)).not.toContain(
        path.join(tempDir, "linked-review")
      );
      expect(harness.watchers.map((fake) => fake.watchedPath)).not.toContain(
        path.join(tempDir, "linked-review", "src")
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("watches module-name folders before extension.ts exists", async () => {
    await mkdir(path.join(tempDir, "draft-review"), { recursive: true });
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);
    const draftWatcher = harness.watchers.find(
      (fake) => fake.watchedPath === path.join(tempDir, "draft-review")
    );
    expect(draftWatcher).toBeDefined();

    draftWatcher!.emitChange("extension.ts");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });

  test("reloads when an Extension Module folder is created", async () => {
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);
    harness.watchers[0].emitChange("other-review");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });

  test("reloads when an Extension Module manifest changes", async () => {
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);
    const moduleWatcher = harness.watchers.find(
      (fake) => fake.watchedPath === path.join(tempDir, "acme-review")
    );
    expect(moduleWatcher).toBeDefined();

    moduleWatcher!.emitChange("extension.ts");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });

  test("reloads when nested Extension Module source changes", async () => {
    await mkdir(path.join(tempDir, "acme-review", "src"), { recursive: true });
    await writeFile(path.join(tempDir, "acme-review", "src", "register.ts"), "export {};\n");
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);
    const srcWatcher = harness.watchers.find(
      (fake) => fake.watchedPath === path.join(tempDir, "acme-review", "src")
    );
    expect(srcWatcher).toBeDefined();

    srcWatcher!.emitChange("register.ts");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });

  test("reloads when an Extension Module body outside skills changes", async () => {
    await mkdir(path.join(tempDir, "acme-review", "docs", "review"), { recursive: true });
    await writeFile(
      path.join(tempDir, "acme-review", "docs", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review helper\n---\n# Review\n"
    );
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);
    const bodyDirWatcher = harness.watchers.find(
      (fake) => fake.watchedPath === path.join(tempDir, "acme-review", "docs", "review")
    );
    expect(bodyDirWatcher).toBeDefined();

    bodyDirWatcher!.emitChange("SKILL.md");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });

  test("reloads when a referenced Extension Module SKILL.md changes", async () => {
    await mkdir(path.join(tempDir, "acme-review", "skills", "review"), { recursive: true });
    await writeFile(
      path.join(tempDir, "acme-review", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review helper\n---\n# Review\n"
    );
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);
    const skillDirWatcher = harness.watchers.find(
      (fake) => fake.watchedPath === path.join(tempDir, "acme-review", "skills", "review")
    );
    expect(skillDirWatcher).toBeDefined();

    skillDirWatcher!.emitChange("SKILL.md");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });

  test("reloads when an Extension Module skill body uses a custom filename", async () => {
    await mkdir(path.join(tempDir, "acme-review", "skills", "review"), { recursive: true });
    await writeFile(
      path.join(tempDir, "acme-review", "skills", "review", "review-body.md"),
      "---\nname: review\ndescription: Review helper\n---\n# Review\n"
    );
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });

    await watcher.setRoots([{ rootId: "user-global", kind: "user-global", path: tempDir }]);
    const skillDirWatcher = harness.watchers.find(
      (fake) => fake.watchedPath === path.join(tempDir, "acme-review", "skills", "review")
    );
    expect(skillDirWatcher).toBeDefined();

    skillDirWatcher!.emitChange("review-body.md");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });
});

describe("ExtensionRootWatcher — project lockfiles", () => {
  test("watches the project .mux directory even when the active root is materialized elsewhere", async () => {
    const harness = createFakeWatch();
    const projectPath = "/fake/project-with-lock";
    const activeRootPath = "/fake/mux/extensions/projects/project-key";
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });

    await watcher.setRoots([
      {
        rootId: `project-local:${projectPath}`,
        kind: "project-local",
        path: activeRootPath,
        trusted: true,
      },
    ]);

    const lockDirWatcher = harness.watchers.find(
      (fake) => fake.watchedPath === path.join(projectPath, ".mux")
    );
    expect(lockDirWatcher).toBeDefined();

    lockDirWatcher!.emitChange("extensions.lock.json");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
  });
});

describe("ExtensionRootWatcher — trust transitions", () => {
  test("untrusting a project-local root tears down its watcher", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    const trusted = projectRoot({ trusted: true });
    await watcher.setRoots([trusted]);
    expect(harness.watchers).toHaveLength(1);
    expect(harness.watchers[0].closed).toBe(false);

    await watcher.setRoots([{ ...trusted, trusted: false }]);
    expect(harness.watchers).toHaveLength(1);
    expect(harness.watchers[0].closed).toBe(true);
  });

  test("trusting a project-local root starts a watcher", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    const untrusted = projectRoot({ trusted: false });
    await watcher.setRoots([untrusted]);
    expect(harness.watchers).toHaveLength(0);

    await watcher.setRoots([{ ...untrusted, trusted: true }]);
    expect(harness.watchers).toHaveLength(1);
    expect(harness.watchers[0].closed).toBe(false);
  });

  test("changing a root path for the same project-local root restarts watchers", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    const firstRoot: ExtensionRootDescriptor = {
      rootId: "project-local:/fake/project",
      kind: "project-local",
      path: "/fake/mux/extensions/projects/project-key",
      trusted: true,
    };
    const secondRoot: ExtensionRootDescriptor = {
      ...firstRoot,
      path: "/fake/project/.mux/extensions",
    };

    await watcher.setRoots([firstRoot]);
    expect(harness.watchers[0].watchedPath).toBe(firstRoot.path);

    await watcher.setRoots([secondRoot]);

    expect(harness.watchers[0].closed).toBe(true);
    expect(harness.watchers.some((item) => item.watchedPath === secondRoot.path)).toBe(true);
  });

  test("repeated setRoots with identical eligible roots does not restart watchers", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    await watcher.setRoots([userGlobalRoot]);
    await watcher.setRoots([userGlobalRoot]);
    expect(harness.watchers).toHaveLength(1);
    expect(harness.watchers[0].closed).toBe(false);
  });
});

describe("ExtensionRootWatcher — debounce", () => {
  test("collapses rapid module events into a single onChange after the debounce window", async () => {
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 30,
      log: silentLog,
    });
    await watcher.setRoots([userGlobalRoot]);

    harness.watchers[0].emitChange("acme-review");
    harness.watchers[0].emitChange("other-review");
    harness.watchers[0].emitChange("acme-review");

    expect(calls).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
  });

  test("ignores events for unrelated filenames", async () => {
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });
    await watcher.setRoots([userGlobalRoot]);

    harness.watchers[0].emitChange("README.md");
    harness.watchers[0].emitChange("node_modules");
    harness.watchers[0].emitChange("package.json");
    harness.watchers[0].emitChange("bun.lock");

    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
  });

  test("re-fires onChange for events that arrive after a previous flush", async () => {
    const harness = createFakeWatch();
    let calls = 0;
    using watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });
    await watcher.setRoots([userGlobalRoot]);

    harness.watchers[0].emitChange("acme-review");
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);

    harness.watchers[0].emitChange("acme-review");
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(2);
  });

  test("close cancels a pending debounced callback", async () => {
    const harness = createFakeWatch();
    let calls = 0;
    const watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      watchFn: harness.watchFn,
      debounceMs: 20,
      log: silentLog,
    });
    await watcher.setRoots([userGlobalRoot]);
    harness.watchers[0].emitChange("acme-review");
    watcher.close();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(0);
  });
});

describe("ExtensionRootWatcher — graceful degradation", () => {
  test("fs.watch throwing for one root does not prevent watching the others", async () => {
    const harness = createFakeWatch();
    harness.failPaths.add(userGlobalRoot.path);
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    await watcher.setRoots([userGlobalRoot, projectRoot({ trusted: true })]);
    expect(harness.watchers).toHaveLength(1);
    expect(harness.watchers[0].watchedPath).toBe("/fake/project");
  });

  test("fs.watch failure logs at debug and does not throw", async () => {
    const harness = createFakeWatch();
    harness.failPaths.add(userGlobalRoot.path);
    const debugCalls: unknown[][] = [];
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: { debug: (...args: unknown[]) => debugCalls.push(args) },
    });
    await watcher.setRoots([userGlobalRoot]);
    expect(debugCalls.length).toBeGreaterThan(0);
  });

  test("watcher 'error' event closes the watcher and degrades silently", async () => {
    const harness = createFakeWatch();
    using watcher = new ExtensionRootWatcher({
      onChange: noOp,
      watchFn: harness.watchFn,
      log: silentLog,
    });
    await watcher.setRoots([userGlobalRoot]);
    expect(() => harness.watchers[0].emitError(new Error("boom"))).not.toThrow();
    expect(harness.watchers[0].closed).toBe(true);
  });
});

describe("ExtensionRootWatcher — real fs integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `mux-root-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test("real Extension Module creation triggers a debounced reload", async () => {
    let calls = 0;
    const watcher = new ExtensionRootWatcher({
      onChange: () => {
        calls += 1;
      },
      debounceMs: 30,
      log: silentLog,
    });
    const root: ExtensionRootDescriptor = {
      rootId: "real-user-global",
      kind: "user-global",
      path: tempDir,
    };
    await watcher.setRoots([root]);

    await mkdir(path.join(tempDir, "acme-review"), { recursive: true });
    await writeFile(
      path.join(tempDir, "acme-review", "extension.ts"),
      "export const manifest = {};"
    );

    await new Promise((r) => setTimeout(r, 200));
    watcher.close();
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
