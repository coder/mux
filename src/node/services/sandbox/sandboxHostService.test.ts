/**
 * QuickJS-heavy suite: keep out of broad Bun filters (runs isolated in CI,
 * see .github/workflows: isolated_unit_tests).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tool } from "ai";
import { z } from "zod";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ToolBridge } from "@/node/services/ptc/toolBridge";
import { FULL_GRANTS, LEAST_PRIVILEGE_GRANTS } from "@/common/types/capabilityGrants";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { SandboxHostService } from "./sandboxHostService";

const runtimeFactory = new QuickJSRuntimeFactory();

describe("SandboxHostService", () => {
  test("ephemeral mounts are fresh per acquire and dispose on release", async () => {
    const host = new SandboxHostService();
    const first = await host.acquireMount({ lifetime: "ephemeral", runtimeFactory });
    const result = await first.runtime.eval("return 1 + 1;");
    expect(result.success).toBe(true);
    expect(result.result).toBe(2);
    first.release();
    expect(first.isDisposed).toBe(true);

    const second = await host.acquireMount({ lifetime: "ephemeral", runtimeFactory });
    expect(second).not.toBe(first);
    second.release();
  });

  test("persistent mount shares vars across separate evals and acquires", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-persist",
      sessionDir: tmp.path,
    });

    const write = await mount.runtime.eval("vars.counter = 41; return vars.counter;");
    expect(write.success).toBe(true);
    expect(write.result).toBe(41);

    // Re-acquire: same scope returns the same live mount.
    const again = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-persist",
      sessionDir: tmp.path,
    });
    expect(again).toBe(mount);

    const read = await again.runtime.eval("vars.counter += 1; return vars.counter;");
    expect(read.success).toBe(true);
    expect(read.result).toBe(42);

    mount.release(); // no-op for persistent mounts
    expect(mount.isDisposed).toBe(false);
    await host.disposeScope("ws-persist");
    expect(mount.isDisposed).toBe(true);
  });

  test("vars snapshot/restore survives a simulated restart", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");

    // "Process 1": write vars, snapshot via journal kit, dispose.
    const host1 = new SandboxHostService();
    const mount1 = await host1.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-restart",
      sessionDir: tmp.path,
    });
    const write = await mount1.runtime.eval(
      'vars.searchResults = { hits: [1, 2, 3], query: "foo" }; return true;'
    );
    expect(write.success).toBe(true);
    await host1.disposeScope("ws-restart"); // snapshots before disposing

    // The snapshot is a durable event referencing a blob.
    const journal = new DurableEventJournal(tmp.path);
    const events = await journal.read();
    const snapshot = events.find((e) => e.kind === "sandbox-vars-snapshot");
    expect(snapshot).toBeDefined();

    // "Process 2": fresh service (simulated restart) restores latest snapshot.
    const host2 = new SandboxHostService();
    const mount2 = await host2.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-restart",
      sessionDir: tmp.path,
    });
    expect(mount2).not.toBe(mount1);
    const read = await mount2.runtime.eval("return vars.searchResults;");
    expect(read.success).toBe(true);
    expect(read.result).toEqual({ hits: [1, 2, 3], query: "foo" });
    await host2.disposeScope("ws-restart");
  });

  test("host→guest events: queue + drain via drainHostEvents()", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-events",
      sessionDir: tmp.path,
    });

    mount.postHostEvent({ type: "task-complete", taskId: "t1" });
    mount.postHostEvent({ type: "task-complete", taskId: "t2" });

    const drained = await mount.runtime.eval("return drainHostEvents();");
    expect(drained.success).toBe(true);
    expect(drained.result).toEqual([
      { type: "task-complete", taskId: "t1" },
      { type: "task-complete", taskId: "t2" },
    ]);

    // Queue is empty after draining.
    const empty = await mount.runtime.eval("return drainHostEvents();");
    expect(empty.result).toEqual([]);
    await host.disposeScope("ws-events");
  });

  test("async capability + host event: promise resolves in-guest and completion is delivered", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-async",
      sessionDir: tmp.path,
    });

    // Demo capability: resolves asynchronously AND posts a host event on
    // completion (the mux.task({background:true}) delivery pattern).
    mount.runtime.registerPromiseFunction("startTask", async (name) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      mount.postHostEvent({ type: "task-started", name });
      return { taskId: "task-123" };
    });

    const result = await mount.runtime.eval(`
      return (async () => {
        const handle = await startTask("demo");
        const events = drainHostEvents();
        return { handle, events };
      })();
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      handle: { taskId: "task-123" },
      events: [{ type: "task-started", name: "demo" }],
    });
    await host.disposeScope("ws-async");
  });

  test("least-privilege grants disable vars and host events on the mount", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-denied",
      sessionDir: tmp.path,
      grants: LEAST_PRIVILEGE_GRANTS,
    });

    // vars namespace was never initialized...
    const varsProbe = await mount.runtime.eval("return typeof globalThis.vars;");
    expect(varsProbe.result).toBe("undefined");
    // ...and the drain bridge is not exposed.
    const drainProbe = await mount.runtime.eval("return typeof globalThis.drainHostEvents;");
    expect(drainProbe.result).toBe("undefined");
    // Host-side APIs refuse too (clear errors, not crashes).
    expect(() => mount.postHostEvent({})).toThrow(/hostEvents grant/);
    try {
      await mount.snapshotVars();
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(String(e)).toContain("vars grant");
    }

    // disposeScope must not fail even though snapshotting is not granted.
    await host.disposeScope("ws-denied");
    expect(mount.isDisposed).toBe(true);
  });

  test("denied bridge capability produces a clear catchable guest error, not a crash", async () => {
    const host = new SandboxHostService();
    const mount = await host.acquireMount({ lifetime: "ephemeral", runtimeFactory });

    const tools = {
      file_read: tool({
        description: "read",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ content: "granted!" }),
      }),
      bash: tool({
        description: "run",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ output: "should never run" }),
      }),
    };
    const bridge = new ToolBridge(tools, {
      version: 1,
      bridgeTools: { allow: ["file_read"] },
      vars: false,
      hostEvents: false,
    });
    bridge.register(mount.runtime);

    const result = await mount.runtime.eval(`
      const granted = mux.file_read({});
      let denied;
      try {
        mux.bash({});
        denied = "no error";
      } catch (e) {
        denied = e.message;
      }
      return { granted, denied, sandboxStillWorks: 1 + 1 };
    `);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      granted: { content: "granted!" },
      denied: "Capability denied: mux.bash is not granted for this sandbox",
      sandboxStillWorks: 2,
    });
    mount.release();
  });

  test("concurrent first acquisitions share one mount (no double runtime creation)", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const [a, b] = await Promise.all([
      host.acquireMount({
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-race",
        sessionDir: tmp.path,
      }),
      host.acquireMount({
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-race",
        sessionDir: tmp.path,
      }),
    ]);
    expect(b).toBe(a);
    await host.disposeScope("ws-race");
  });

  test("withPersistentMount holds the lease: concurrent disposal waits for fn to finish", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const order: string[] = [];
    let releaseFn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    const run = host.withPersistentMount(
      {
        lifetime: "persistent",
        runtimeFactory,
        scopeKey: "ws-lease",
        sessionDir: tmp.path,
      },
      async (mount) => {
        order.push("fn-start");
        await gate;
        // The mount must still be live: disposeScope started while fn held
        // the lease and must be queued behind it, not race it.
        expect(mount.isDisposed).toBe(false);
        const result = await mount.runtime.eval("return 7;");
        order.push("fn-end");
        return result;
      }
    );
    // Give fn time to enter the lease, then attempt disposal concurrently.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const disposal = host.disposeScope("ws-lease").then(() => order.push("disposed"));
    releaseFn?.();
    const result = await run;
    await disposal;
    expect(result.success).toBe(true);
    expect(order).toEqual(["fn-start", "fn-end", "disposed"]);
  });

  test("exclusive() serializes concurrent runs on a shared mount", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-serial",
      sessionDir: tmp.path,
    });
    const order: string[] = [];
    await Promise.all([
      mount.exclusive(async () => {
        order.push("a-start");
        // Yield long enough that an unserialized implementation interleaves b.
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a-end");
      }),
      mount.exclusive(async () => {
        order.push("b-start");
        await Promise.resolve();
        order.push("b-end");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    await host.disposeScope("ws-serial");
  });

  test("dropScope: workspace removal disposes the mount without writing to disk", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-drop",
      sessionDir: tmp.path,
    });
    const write = await mount.runtime.eval("vars.x = 1; return vars.x;");
    expect(write.success).toBe(true);

    // Record disk state, then drop: the mount must be disposed and NO new
    // files may appear (the caller is deleting the session directory).
    const before = readdirSync(tmp.path, { recursive: true }).length;
    await host.dropScope("ws-drop");
    expect(mount.isDisposed).toBe(true);
    expect(host.hasScope("ws-drop")).toBe(false);
    const after = readdirSync(tmp.path, { recursive: true }).length;
    expect(after).toBe(before);
  });

  test("discardScope: context reset discards vars instead of restoring the last snapshot", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reset",
      sessionDir: tmp.path,
    });
    const write = await mount.runtime.eval("vars.secret = 'pre-reset'; return vars.secret;");
    expect(write.success).toBe(true);
    await mount.persistVars();

    await host.discardScope("ws-reset", tmp.path);
    expect(mount.isDisposed).toBe(true);

    // The next mount must start fresh, NOT restore pre-reset state.
    const fresh = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-reset",
      sessionDir: tmp.path,
    });
    expect(fresh).not.toBe(mount);
    const probe = await fresh.runtime.eval("return Object.keys(vars).length;");
    expect(probe.success).toBe(true);
    expect(probe.result).toBe(0);
    await host.disposeScope("ws-reset");
  });

  test("reacquiring with changed grants rebuilds the mount under the new grants", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const full = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-grant-change",
      sessionDir: tmp.path,
    });
    const write = await full.runtime.eval("vars.x = 1; return vars.x;");
    expect(write.success).toBe(true);

    // Same scope, narrowed grants: the full-grants mount must not be reused.
    const narrowed = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-grant-change",
      sessionDir: tmp.path,
      grants: LEAST_PRIVILEGE_GRANTS,
    });
    expect(narrowed).not.toBe(full);
    expect(full.isDisposed).toBe(true);
    // The rebuilt mount enforces the new boundary: no vars, no drain bridge.
    const varsProbe = await narrowed.runtime.eval("return typeof globalThis.vars;");
    expect(varsProbe.result).toBe("undefined");
    const drainProbe = await narrowed.runtime.eval("return typeof globalThis.drainHostEvents;");
    expect(drainProbe.result).toBe("undefined");
    await host.disposeScope("ws-grant-change");
  });

  test("bridge narrowing rebuilds the mount, revoking guest-saved bridge references", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const tools = {
      bash: tool({
        description: "run",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ output: "ran" }),
      }),
    };

    const broadMount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-saved-ref",
      sessionDir: tmp.path,
      bridgeKey: "bash",
    });
    new ToolBridge(tools, FULL_GRANTS).register(broadMount.runtime);
    // Guest saves a bridge reference in a global — re-registering `mux` can
    // never revoke this closure; only destroying the runtime can.
    const saved = await broadMount.runtime.eval(
      "globalThis.savedBash = mux.bash; vars.keep = 1; return typeof savedBash;"
    );
    expect(saved.result).toBe("function");

    // Policy narrowed: the effective bridge no longer includes bash.
    const narrowedMount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-saved-ref",
      sessionDir: tmp.path,
      bridgeKey: "",
    });
    expect(narrowedMount).not.toBe(broadMount);
    expect(broadMount.isDisposed).toBe(true);
    // Saved closure is gone with the old runtime; vars survived the rebuild.
    const probe = await narrowedMount.runtime.eval(
      "return { saved: typeof globalThis.savedBash, kept: vars.keep };"
    );
    expect(probe.result).toEqual({ saved: "undefined", kept: 1 });
    await host.disposeScope("ws-saved-ref");
  });

  test("re-registering a narrower bridge on a reused runtime revokes previously exposed tools", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host = new SandboxHostService();
    const mount = await host.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-rebridge",
      sessionDir: tmp.path,
    });
    const tools = {
      bash: tool({
        description: "run",
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ output: "ran" }),
      }),
    };

    const broad = new ToolBridge(tools, {
      version: 1,
      bridgeTools: { allow: "all" },
      vars: true,
      hostEvents: true,
    });
    broad.register(mount.runtime);
    const allowed = await mount.runtime.eval("return mux.bash({});");
    expect(allowed.success).toBe(true);
    expect(allowed.result).toEqual({ output: "ran" });

    // Next request narrowed the policy: code_execution re-registers its fresh
    // bridge on the reused runtime, which must fully replace the old one.
    const narrow = new ToolBridge(tools, {
      version: 1,
      bridgeTools: { allow: [] },
      vars: true,
      hostEvents: true,
    });
    narrow.register(mount.runtime);
    const denied = await mount.runtime.eval(`
      try {
        mux.bash({});
        return "no error";
      } catch (e) {
        return e.message;
      }
    `);
    expect(denied.success).toBe(true);
    expect(denied.result).toBe("Capability denied: mux.bash is not granted for this sandbox");
    await host.disposeScope("ws-rebridge");
  });

  test("corrupt snapshot blob self-heals to empty vars", async () => {
    using tmp = new DisposableTempDir("sandbox-host-test");
    const host1 = new SandboxHostService();
    const mount1 = await host1.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-heal",
      sessionDir: tmp.path,
    });
    await mount1.runtime.eval("vars.x = 1; return true;");
    await host1.disposeScope("ws-heal");

    // Corrupt every blob under the session dir.
    const corruptDir = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) corruptDir(full);
        else writeFileSync(full, "corrupted!");
      }
    };
    corruptDir(join(tmp.path, "blobs"));

    const host2 = new SandboxHostService();
    const mount2 = await host2.acquireMount({
      lifetime: "persistent",
      runtimeFactory,
      scopeKey: "ws-heal",
      sessionDir: tmp.path,
    });
    const read = await mount2.runtime.eval("return vars;");
    expect(read.success).toBe(true);
    expect(read.result).toEqual({});
    await host2.disposeScope("ws-heal");
  });
});
