"use strict";

// Worker-pool sizing for tools that fan out across cores (ESLint, Jest).
//
// Agent containers can expose 96 CPUs and a 128 GiB host while capping the workspace far lower
// through cgroup v2 (32 GiB here), and that cap can sit on an ANCESTOR cgroup while the leaf reports
// "max". Node's process.constrainedMemory() only reads the leaf, so it answers 2^64 ("unlimited")
// and any pool sized from it collapses to a plain CPU count. Dozens of multi-GiB workers then get
// the whole run SIGKILLed. Hence: resolve the cap across the cgroup chain and size pools against
// memory rather than cores.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BYTES_PER_GIB = 1024 ** 3;
const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";
const DEFAULT_PROC_SELF_CGROUP = "/proc/self/cgroup";

// cgroup v1 spells "unlimited" as a saturated integer rather than "max", so treat implausibly large
// caps as absent instead of trusting them.
const UNLIMITED_BYTES_FLOOR = 2n ** 62n;

// Peak resident set measured per worker on this repo: ESLint runs its --concurrency lanes as worker
// threads sharing one heap (~2.8 GiB each), Jest forks processes that reach ~4.7 GiB rendering the
// full app. Both are rounded up to absorb the parent process and growth.
const PROFILES = {
  eslint: { memoryPerWorkerGib: 4, maxWorkers: 4 },
  jest: { memoryPerWorkerGib: 6, maxWorkers: 4 },
};

const CPU_FRACTION = 0.5;

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseBytes(raw) {
  if (raw == null) {
    return null;
  }
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  let value;
  try {
    value = BigInt(text);
  } catch {
    return null;
  }
  if (value < 0n) {
    return null;
  }
  return value;
}

function parseLimitBytes(raw) {
  const value = parseBytes(raw);
  if (value == null || value === 0n || value >= UNLIMITED_BYTES_FLOOR) {
    return null;
  }
  return Number(value);
}

/** Cgroup v2 directories from the leaf the process lives in up to the mount root. */
function cgroupDirChain(options) {
  const cgroupRoot = options.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
  const raw = readFileOrNull(options.procSelfCgroup ?? DEFAULT_PROC_SELF_CGROUP);
  const v2Line = raw
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("0::"));
  const segments = (v2Line?.slice("0::".length) ?? "").split("/").filter(Boolean);

  const chain = [];
  for (let depth = segments.length; depth >= 0; depth--) {
    chain.push(path.join(cgroupRoot, ...segments.slice(0, depth)));
  }
  return chain;
}

/**
 * The most restrictive memory cap that applies to this process, plus the directory that imposes it.
 * Usage has to be read from that same directory: sibling workspaces sharing an ancestor cgroup are
 * invisible from the leaf.
 */
function resolveMemoryConstraint(options = {}) {
  let constraint = null;

  for (const dir of cgroupDirChain(options)) {
    const limitBytes = parseLimitBytes(readFileOrNull(path.join(dir, "memory.max")));
    if (limitBytes != null && (constraint == null || limitBytes < constraint.limitBytes)) {
      constraint = { dir, limitBytes };
    }
  }
  if (constraint != null) {
    return constraint;
  }

  const cgroupRoot = options.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
  const v1Dir = path.join(cgroupRoot, "memory");
  const v1Limit = parseLimitBytes(readFileOrNull(path.join(v1Dir, "memory.limit_in_bytes")));
  return v1Limit == null ? null : { dir: v1Dir, limitBytes: v1Limit };
}

function parseMemoryStat(dir) {
  const raw = readFileOrNull(path.join(dir, "memory.stat"));
  if (raw == null) {
    return null;
  }

  const values = new Map();
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    const parsed = parseBytes(value);
    if (key && parsed != null) {
      values.set(key, Number(parsed));
    }
  }
  return values;
}

/**
 * Memory in the cgroup that a new worker cannot claim. memory.current is unusable on its own because
 * it counts page cache the kernel drops on demand; anon + kernel + shmem is the floor that cannot be
 * reclaimed, so take whichever estimate is larger.
 */
function readCgroupUsageBytes(dir) {
  const stat = parseMemoryStat(dir);
  if (stat == null) {
    return null;
  }

  const unreclaimable =
    (stat.get("anon") ?? 0) + (stat.get("kernel") ?? stat.get("slab") ?? 0) + (stat.get("shmem") ?? 0);

  const current = parseBytes(readFileOrNull(path.join(dir, "memory.current")));
  const inactiveFile = stat.get("inactive_file");
  if (current != null && inactiveFile != null) {
    return Math.max(unreclaimable, Number(current) - inactiveFile);
  }
  return unreclaimable;
}

function computeWorkers(input) {
  const cpuWorkers = Math.max(1, Math.floor(input.cpuCount * CPU_FRACTION));

  // Leaves room for everything the pool does not account for: the tool's own parent process, page
  // cache it is actively reading through, and sibling workspaces starting work mid-run.
  const reserveBytes = Math.max(2 * BYTES_PER_GIB, input.limitBytes * 0.15);
  const usableBytes = Math.max(0, input.limitBytes - input.inUseBytes - reserveBytes);
  const memoryWorkers = Math.floor(usableBytes / (input.memoryPerWorkerGib * BYTES_PER_GIB));

  return Math.max(1, Math.min(cpuWorkers, memoryWorkers, input.maxWorkers));
}

function resolveWorkerBudget(profileName, options = {}) {
  const profile = PROFILES[profileName];
  if (profile == null) {
    throw new Error(
      `unknown worker budget profile "${profileName}" (expected one of: ${Object.keys(PROFILES).join(", ")})`
    );
  }

  const constraint = resolveMemoryConstraint(options);
  // Without a cgroup cap (macOS, CI VMs) there are no co-tenants to account for, and subtracting
  // free-memory swings would make a busy laptop silently serialize its own test run.
  const limitBytes = constraint?.limitBytes ?? os.totalmem();
  const inUseBytes = constraint == null ? 0 : (readCgroupUsageBytes(constraint.dir) ?? 0);

  const input = {
    ...profile,
    cpuCount: os.availableParallelism?.() ?? os.cpus().length,
    limitBytes,
    inUseBytes,
  };
  return { ...input, cgroupDir: constraint?.dir ?? null, workers: computeWorkers(input) };
}

function formatWorkerBudget(budget) {
  const gib = (bytes) => `${(bytes / BYTES_PER_GIB).toFixed(1)}GiB`;
  return [
    `workers=${budget.workers}`,
    `limit=${gib(budget.limitBytes)}`,
    `inUse=${gib(budget.inUseBytes)}`,
    `perWorker=${budget.memoryPerWorkerGib}GiB`,
    `cpus=${budget.cpuCount}`,
    `cgroup=${budget.cgroupDir ?? "none"}`,
  ].join(" ");
}

function workerBudgetFor(profileName) {
  const budget = resolveWorkerBudget(profileName);
  if (process.env.MUX_WORKER_BUDGET_DEBUG) {
    process.stderr.write(`[worker-budget] ${profileName} ${formatWorkerBudget(budget)}\n`);
  }
  return budget.workers;
}

module.exports = {
  BYTES_PER_GIB,
  PROFILES,
  computeWorkers,
  formatWorkerBudget,
  readCgroupUsageBytes,
  resolveMemoryConstraint,
  resolveWorkerBudget,
  workerBudgetFor,
};

if (require.main === module) {
  const profileName = process.argv[2];
  const budget = resolveWorkerBudget(profileName);
  if (process.argv.includes("--debug") || process.env.MUX_WORKER_BUDGET_DEBUG) {
    process.stderr.write(`[worker-budget] ${profileName} ${formatWorkerBudget(budget)}\n`);
  }
  process.stdout.write(`${budget.workers}\n`);
}
