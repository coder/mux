/**
 * PROTOTYPE — throwaway V0 reconcile-loop driver. Wipe me.
 *
 * One tick of the dispatcher: observe -> reconcile (pure) -> actuate.
 * Cron (or a human in a loop) provides the schedule; this never sleeps.
 *
 * Usage (from repo root, against a sandboxed server):
 *   MUX_ROOT=<sandbox root> bun scripts/prototypes/reconcile-loop/tick.ts \
 *     --source scripts/prototypes/reconcile-loop/fixture.json \
 *     --project /tmp/reconcile-target-repo [--dry-run] [--max-spawns 2] [--model anthropic:claude-haiku-4-5]
 *
 *   --source gh:owner/repo uses the real GitHub adapter via `gh issue list`.
 *
 * Server discovery: relies on `mux api`'s lockfile discovery, so point MUX_ROOT
 * at the sandbox root (see dev-server-sandbox skill). NEVER run this against
 * your real ~/.mux without --dry-run first.
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  issuesToWorkItems,
  reconcile,
  type Actual,
  type SourceIssue,
  type WorkItem,
} from "./reconcile";

// --- arg parsing (minimal) ---
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const source = argValue("--source");
const projectPath = argValue("--project");
const dryRun = process.argv.includes("--dry-run");
const maxSpawns = Number(argValue("--max-spawns") ?? "2");
const model = argValue("--model") ?? "anthropic:claude-haiku-4-5";
assert(source, "--source <fixture.json | gh:owner/repo> is required");
assert(projectPath, "--project <path> is required");

// --- skip-if-previous-tick-running guard ---
const lockPath = path.join(os.tmpdir(), "reconcile-loop-prototype.lock");
try {
  fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
} catch {
  console.error(`[tick] previous tick still running (lock ${lockPath}); skipping`);
  process.exit(0);
}
process.on("exit", () => fs.rmSync(lockPath, { force: true }));

// --- mux api actuator ---
function muxApi(args: string[]): string {
  // Spike hack: shells the local CLI bundle. V1 replaces this with typed
  // built-in workflow actions (action.workspace.*).
  return execFileSync("bun", ["dist/cli/api.mjs", ...args], { encoding: "utf-8" });
}

function listActuals(): Actual[] {
  const fetch = (archived: boolean): Actual[] => {
    // trpc-cli quirks: empty arrays print nothing; non-empty arrays print as
    // CONCATENATED pretty JSON objects, not a JSON array. Rejoin before parsing.
    // (V1 learning: shelling the CLI is a lossy transport — typed actions needed.)
    const out = muxApi(["workspace", "list", ...(archived ? ["--archived"] : [])]).trim();
    const raw: unknown =
      out === "" ? [] : JSON.parse(`[${out.replace(/\n\}\n\{\n/g, "\n},\n{\n")}]`);
    assert(Array.isArray(raw), "workspace list did not return an array");
    return raw
      .map((w: { id: string; title?: string; name?: string }) => ({
        workspaceId: w.id,
        // Spike hack: idempotency key is recovered from title (set at spawn).
        key: w.title ?? w.name ?? "",
        archived,
      }))
      .filter((a) => /^issue-\d+-(investigate|implement)$/.test(a.key));
  };
  return [...fetch(false), ...fetch(true)];
}

// --- source adapters ---
function fetchIssues(src: string): SourceIssue[] {
  if (src.startsWith("gh:")) {
    const repo = src.slice(3);
    const raw: unknown = JSON.parse(
      execFileSync(
        "gh",
        ["issue", "list", "--repo", repo, "--state", "all", "--json", "number,title,labels,state"],
        { encoding: "utf-8" }
      )
    );
    assert(Array.isArray(raw), "gh issue list did not return an array");
    return raw.map(
      (i: { number: number; title: string; labels: Array<{ name: string }>; state: string }) => ({
        number: i.number,
        title: i.title,
        labels: i.labels.map((l) => l.name),
        state: i.state === "CLOSED" ? "CLOSED" : "OPEN",
      })
    );
  }
  const raw: unknown = JSON.parse(fs.readFileSync(src, "utf-8"));
  assert(Array.isArray(raw), "fixture must be an array of issues");
  return raw as SourceIssue[];
}

// --- actuation ---
function spawn(item: WorkItem): void {
  const createOut: unknown = JSON.parse(
    muxApi([
      "workspace",
      "create",
      "--project-path",
      projectPath!,
      "--branch-name",
      item.key,
      // Learning: trunkBranch is required for worktree runtimes — the desktop UI
      // auto-detects it; API callers must supply it. V1's ensure action should detect.
      "--trunk-branch",
      "main",
      "--title",
      item.key,
    ])
  );
  const create = createOut as { success: boolean; error?: string; metadata?: { id: string } };
  assert(create.success, `workspace create failed for ${item.key}: ${create.error}`);
  const workspaceId = create.metadata!.id;

  muxApi([
    "workspace",
    "send-message",
    "--workspace-id",
    workspaceId,
    "--message",
    item.prompt,
    "--options",
    JSON.stringify({ model, agentId: "exec", mode: "exec" }),
  ]);
  // Claim is human-visibility only in v1 — log instead of writing to the source.
  console.log(
    `[claim] would write back to source: "${item.key} started, workspace ${workspaceId}"`
  );
}

// --- tick ---
const issues = fetchIssues(source);
const items = issuesToWorkItems(issues);
const actuals = listActuals();
const plan = reconcile(items, actuals, { maxSpawns });

console.log("=== observed work items ===");
for (const i of items) console.log(`  ${i.key}  done=${i.done}`);
console.log("=== observed actuals (mux workspaces) ===");
for (const a of actuals) console.log(`  ${a.key}  id=${a.workspaceId} archived=${a.archived}`);
console.log("=== plan ===");
for (const p of plan) {
  if (p.kind === "spawn") console.log(`  SPAWN   ${p.item.key}`);
  else if (p.kind === "archive") console.log(`  ARCHIVE ${p.key} (${p.workspaceId})`);
  else console.log(`  BLOCKED ${p.key}: ${p.reason}`);
}

if (dryRun) {
  console.log("[tick] dry-run: no actions executed");
  process.exit(0);
}

for (const p of plan) {
  if (p.kind === "spawn") {
    console.log(`[tick] spawning ${p.item.key}...`);
    spawn(p.item);
  } else if (p.kind === "archive") {
    console.log(`[tick] archiving ${p.key} (${p.workspaceId})...`);
    muxApi(["workspace", "archive", "--workspace-id", p.workspaceId]);
  }
}
console.log("[tick] done");
