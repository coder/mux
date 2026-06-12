/**
 * Built-in `workspace.*` workflow actions ("host actions").
 *
 * Unlike other built-in actions (git.*, security.*) which run as sandboxed Node
 * child processes with only shell access, these actions need the in-memory
 * backend services (WorkspaceService, HistoryService) of the running mux host.
 * They power deterministic orchestration loops ("reconciler" workflows) that
 * ensure/message/observe/archive persistent workspaces keyed by a work item.
 *
 * Mechanism: each action here is registered twice —
 * 1. A generated CJS *stub source* (metadata + throwing execute) is merged into
 *    BUILT_IN_WORKFLOW_ACTION_SOURCES so the registry, `describe()` static
 *    parsing, and replay input-hashing work unchanged.
 * 2. The real TS implementation is passed to WorkflowActionRunner as a host
 *    action map; the runner dispatches built-in actions found in that map
 *    in-process instead of spawning a child.
 * If the host map is not wired (e.g. `mux workflow run` CLI without backend
 * services), executing falls through to the stub, which throws a clear error —
 * fail-fast instead of silently misbehaving.
 *
 * Design notes (from the reconcile-loop dispatcher design):
 * - `ensure` is idempotent by work-item key (workspace tag `workItemKey`), so
 *   it is replay-safe and exports `reconcile = execute`.
 * - `sendMessage` deliberately has NO reconcile: re-sending a chat message is
 *   not idempotent. A crashed workflow must restart the loop (which re-derives
 *   the plan from observed state) rather than replay a half-finished send.
 * - `archive` is a reconciliation outcome (source says done), idempotent.
 */

import { createHash } from "crypto";
import assert from "@/common/utils/assert";
import { z } from "zod";
import type { Config } from "@/node/config";
import { detectDefaultTrunkBranch } from "@/node/git";
import type { HistoryService } from "@/node/services/historyService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { normalizeAgentId } from "@/common/utils/agentIds";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import {
  validateWorkflowActionMetadata,
  type HostWorkflowAction,
  type HostWorkflowActionContext,
  type WorkflowActionMetadata,
} from "./WorkflowActionRunner";

/** Tag key used by workspace.ensure to identify a workspace by work item. */
export const WORK_ITEM_TAG_KEY = "workItemKey";

/**
 * Narrow structural slices of the backend services — exactly the members the
 * host actions touch. Keeps the dependency surface explicit and lets tests
 * provide minimal fakes without casting.
 */
export interface WorkspaceHostActionServices {
  workspaceService: Pick<
    WorkspaceService,
    "list" | "create" | "sendMessage" | "archive" | "getGoalContinuationRuntimeState"
  >;
  historyService: Pick<HistoryService, "getHistoryFromLatestBoundary">;
  config: Pick<Config, "loadConfigOrDefault" | "findWorkspace" | "getAllWorkspaceMetadata">;
  /** Test hook: poll interval for awaitIdle (default 500ms). */
  awaitIdlePollMs?: number;
}

const AWAIT_IDLE_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const AWAIT_IDLE_MAX_TIMEOUT_MS = 10 * 60 * 1000;
const AWAIT_IDLE_POLL_MS = 500;

/** Fail fast when the workflow run was aborted before/while mutating state. */
function throwIfAborted(ctx: HostWorkflowActionContext, actionName: string): void {
  if (ctx.abortSignal?.aborted === true) {
    throw new Error(`${actionName} aborted: workflow run was interrupted`);
  }
}

interface WorkspaceHostActionDefinition {
  metadata: WorkflowActionMetadata;
  hasReconcile: boolean;
  createExecute: (
    services: WorkspaceHostActionServices
  ) => (input: unknown, ctx: HostWorkflowActionContext) => Promise<unknown>;
}

const ListInputSchema = z
  .object({
    tagKey: z.string().min(1).nullish(),
    tagValue: z.string().nullish(),
    includeArchived: z.boolean().nullish(),
  })
  // tagValue without tagKey would silently return everything; reject instead.
  .refine((input) => input.tagValue == null || input.tagKey != null, {
    message: "tagValue requires tagKey",
  });

const EnsureInputSchema = z.object({
  projectPath: z.string().min(1),
  key: z.string().min(1),
  title: z.string().min(1).nullish(),
  trunkBranch: z.string().min(1).nullish(),
  branchName: z.string().min(1).nullish(),
});

const SendMessageInputSchema = z.object({
  workspaceId: z.string().min(1),
  message: z.string().min(1),
  agentId: z.string().min(1).nullish(),
  model: z.string().min(1).nullish(),
});

const AwaitIdleInputSchema = z.object({
  workspaceId: z.string().min(1),
  timeoutMs: z.number().int().positive().max(AWAIT_IDLE_MAX_TIMEOUT_MS).nullish(),
});

const WorkspaceIdInputSchema = z.object({
  workspaceId: z.string().min(1),
});

function listedWorkspace(metadata: {
  id: string;
  name: string;
  title?: string;
  projectPath: string;
  tags?: Record<string, string>;
  archivedAt?: string;
  unarchivedAt?: string;
  taskStatus?: string;
}) {
  return {
    workspaceId: metadata.id,
    name: metadata.name,
    title: metadata.title,
    projectPath: metadata.projectPath,
    tags: metadata.tags ?? {},
    archived: isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt),
    taskStatus: metadata.taskStatus,
  };
}

/**
 * Idempotency predicate for workspace.ensure. Reads config metadata directly
 * instead of WorkspaceService.list(): list() swallows read errors into [] and
 * filters hidden workspaces — both would make a transient failure look like
 * "no workspace exists" and trigger a duplicate create.
 *
 * Scoped to the requested/owning project: work-item keys are only unique per
 * source, so two projects may legitimately reuse a key (e.g. "issue-1"); a
 * global match would resolve ensure to a workspace in the wrong repo.
 */
async function findWorkspaceByWorkItemKey(
  services: WorkspaceHostActionServices,
  key: string,
  projectPaths: ReadonlySet<string>
) {
  const all = await services.config.getAllWorkspaceMetadata();
  return all.find(
    (metadata) =>
      metadata.tags?.[WORK_ITEM_TAG_KEY] === key &&
      projectPaths.has(stripTrailingSlashes(metadata.projectPath))
  );
}

/**
 * Look up a workspace by id from the live WorkspaceService.list(). Shared by the
 * id-targeted host actions (sendMessage/archive), which receive an explicit
 * workspaceId. Distinct from findWorkspaceByWorkItemKey, which reads config
 * directly to avoid list()'s hidden-workspace filtering and error swallowing.
 */
async function findWorkspaceById(services: WorkspaceHostActionServices, workspaceId: string) {
  const all = await services.workspaceService.list();
  return all.find((metadata) => metadata.id === workspaceId);
}

/**
 * Work-item keys (e.g. "PROJ-123", "release/v1.2") rarely satisfy
 * validateWorkspaceName ([a-z0-9_-], max 64 chars), which would make
 * workspace.create reject the ensure permanently. Normalize like fork naming
 * does and append a short hash of the original key when truncation could
 * collapse distinct keys onto the same branch name.
 */
export function deriveEnsureBranchName(raw: string): string {
  assert(raw.length > 0, "deriveEnsureBranchName: key must be non-empty");
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (sanitized.length > 0 && sanitized.length <= 64) {
    return sanitized;
  }
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  if (sanitized.length === 0) {
    return `work-item-${hash}`;
  }
  // 64-char budget: 55 prefix + "-" + 8 hash.
  return `${sanitized.slice(0, 55).replace(/-+$/, "")}-${hash}`;
}

/**
 * Serialize async work per string key. workspace.ensure's check-then-create is
 * not atomic (worktree creation takes seconds); without this, overlapping
 * reconcile ticks both miss the predicate and create duplicate workspaces
 * tagged with the same work-item key.
 */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === gate) {
        this.tails.delete(key);
      }
    }
  }
}

const WORKSPACE_HOST_ACTION_DEFINITIONS: Record<string, WorkspaceHostActionDefinition> = {
  "workspace.list": {
    metadata: {
      version: 1,
      description:
        "List mux workspaces (id, name, title, tags, archived) with optional tag filtering",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          tagKey: { type: "string" },
          tagValue: { type: "string" },
          includeArchived: { type: "boolean" },
        },
      },
      outputSchema: { type: "object" },
      timeoutMs: 30_000,
    },
    hasReconcile: false,
    createExecute: (services) => async (rawInput) => {
      const input = ListInputSchema.parse(rawInput ?? {});
      const all = await services.workspaceService.list();
      const workspaces = all
        .map(listedWorkspace)
        .filter((w) => (input.includeArchived === true ? true : !w.archived))
        .filter((w) => {
          if (input.tagKey == null) {
            return true;
          }
          const value = w.tags[input.tagKey];
          if (value === undefined) {
            return false;
          }
          return input.tagValue == null ? true : value === input.tagValue;
        });
      return { workspaces };
    },
  },

  "workspace.ensure": {
    metadata: {
      version: 1,
      description:
        "Idempotently ensure a persistent workspace exists for a work-item key (tag workItemKey); creates it when missing",
      effect: "external",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string" },
          key: { type: "string" },
          title: { type: "string" },
          trunkBranch: { type: "string" },
          branchName: { type: "string" },
        },
        required: ["projectPath", "key"],
      },
      outputSchema: { type: "object" },
      timeoutMs: 120_000,
    },
    hasReconcile: true,
    createExecute: (services) => {
      // Per-wiring mutex: all runners share one host-action map (built once in
      // coreServices), so this serializes every ensure for a given key.
      const ensureMutex = new KeyedMutex();
      return (rawInput, ctx) => {
        const input = EnsureInputSchema.parse(rawInput);
        const requestedProjectPath = stripTrailingSlashes(input.projectPath);
        // Mutex key includes the project: the same work-item key in two
        // projects is two independent ensures (matching the scoped predicate).
        return ensureMutex.run(`${requestedProjectPath}\u0000${input.key}`, async () => {
          throwIfAborted(ctx, "workspace.ensure");

          // Trust gate BEFORE running git on the caller-provided path:
          // workspace.create re-checks trust, but trunk detection below already
          // executes git against the path, which untrusted projects must not get.
          const configSnapshot = services.config.loadConfigOrDefault();
          const requestedProject = configSnapshot.projects.get(requestedProjectPath);
          const owningProjectPath = requestedProject?.parentProjectPath ?? requestedProjectPath;
          if (configSnapshot.projects.get(owningProjectPath)?.trusted !== true) {
            throw new Error(
              `workspace.ensure: project is not registered and trusted: ${input.projectPath}`
            );
          }

          // Sub-project workspaces are bucketed under the owning parent, so a
          // tagged workspace may surface under either path.
          const existing = await findWorkspaceByWorkItemKey(
            services,
            input.key,
            new Set([requestedProjectPath, owningProjectPath])
          );
          if (existing) {
            return {
              created: false,
              workspaceId: existing.id,
              archived: isWorkspaceArchived(existing.archivedAt, existing.unarchivedAt),
            };
          }

          // Worktree/SSH runtimes require an explicit trunk; mirror the desktop
          // UI's auto-detection so callers don't have to know repo internals.
          const trunkBranch =
            input.trunkBranch ?? (await detectDefaultTrunkBranch(input.projectPath));
          const branchName = deriveEnsureBranchName(input.branchName ?? input.key);

          throwIfAborted(ctx, "workspace.ensure");
          const createResult = await services.workspaceService.create(
            input.projectPath,
            branchName,
            trunkBranch,
            input.title ?? input.key,
            undefined,
            undefined,
            undefined,
            { [WORK_ITEM_TAG_KEY]: input.key }
          );
          if (!createResult.success) {
            throw new Error(`workspace.ensure failed to create workspace: ${createResult.error}`);
          }
          return {
            created: true,
            workspaceId: createResult.data.metadata.id,
            archived: false,
          };
        });
      };
    },
  },

  "workspace.sendMessage": {
    metadata: {
      version: 1,
      description:
        "Send a chat message to a workspace, starting a fresh agent turn (queues if the workspace is busy)",
      effect: "external",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          message: { type: "string" },
          agentId: { type: "string" },
          model: { type: "string" },
        },
        required: ["workspaceId", "message"],
      },
      outputSchema: { type: "object" },
      timeoutMs: 60_000,
    },
    hasReconcile: false,
    createExecute: (services) => async (rawInput, ctx) => {
      const input = SendMessageInputSchema.parse(rawInput);
      throwIfAborted(ctx, "workspace.sendMessage");

      const metadata = await findWorkspaceById(services, input.workspaceId);

      // Agent fallback: explicit input → workspace's persisted selected agent →
      // exec. sendMessage persists the selected agent, so defaulting to "exec"
      // blindly would durably overwrite e.g. an "explore" workspace's agent.
      // Plan/compact are UI modes, not message-send targets (mirrors the goal
      // kickoff normalization in WorkspaceService).
      const persistedAgentId = normalizeAgentId(metadata?.agentId, WORKSPACE_DEFAULTS.agentId);
      const agentId =
        input.agentId ??
        (persistedAgentId === "plan" || persistedAgentId === "compact"
          ? WORKSPACE_DEFAULTS.agentId
          : persistedAgentId);

      // Model fallback: explicit input → workspace AI settings → global default.
      let model = input.model ?? undefined;
      if (model == null) {
        model = metadata?.aiSettingsByAgent?.[agentId]?.model ?? metadata?.aiSettings?.model;
        model ??= services.config.loadConfigOrDefault().defaultModel;
      }
      if (model == null) {
        throw new Error(
          "workspace.sendMessage: no model specified and no workspace/global default model configured"
        );
      }

      throwIfAborted(ctx, "workspace.sendMessage");
      const sendResult = await services.workspaceService.sendMessage(
        input.workspaceId,
        input.message,
        { model, agentId }
      );
      if (!sendResult.success) {
        throw new Error(`workspace.sendMessage failed: ${JSON.stringify(sendResult.error)}`);
      }
      return { sent: true, model, agentId };
    },
  },

  "workspace.awaitIdle": {
    metadata: {
      version: 1,
      description:
        "Wait until a workspace has no active or queued agent turn (or until timeoutMs elapses)",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["workspaceId"],
      },
      outputSchema: { type: "object" },
      // Must exceed the largest allowed input timeout so the runner doesn't
      // kill a legitimate wait.
      timeoutMs: AWAIT_IDLE_MAX_TIMEOUT_MS + 30_000,
    },
    hasReconcile: false,
    createExecute: (services) => async (rawInput, ctx) => {
      const input = AwaitIdleInputSchema.parse(rawInput);
      assert(
        services.config.findWorkspace(input.workspaceId) != null,
        `workspace.awaitIdle: workspace not found: ${input.workspaceId}`
      );
      const timeoutMs = input.timeoutMs ?? AWAIT_IDLE_DEFAULT_TIMEOUT_MS;
      const pollMs = services.awaitIdlePollMs ?? AWAIT_IDLE_POLL_MS;
      const startedAt = Date.now();

      for (;;) {
        // Abort must THROW, not return {idle:false}: a returned value would be
        // durably recorded as a successful step result and replayed on resume,
        // permanently feeding the workflow a wrong, premature idle status.
        throwIfAborted(ctx, "workspace.awaitIdle");
        const state = services.workspaceService.getGoalContinuationRuntimeState(input.workspaceId);
        const idle = !state.isBusy && !state.hasQueuedMessages && !state.isInitializing;
        const waitedMs = Date.now() - startedAt;
        if (idle) {
          return { idle: true, waitedMs };
        }
        if (waitedMs >= timeoutMs) {
          return { idle: false, waitedMs };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  },

  "workspace.getLatestAssistantMessage": {
    metadata: {
      version: 1,
      description: "Read the most recent assistant message text from a workspace's chat history",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
        },
        required: ["workspaceId"],
      },
      outputSchema: { type: "object" },
      timeoutMs: 30_000,
    },
    hasReconcile: false,
    createExecute: (services) => async (rawInput) => {
      const input = WorkspaceIdInputSchema.parse(rawInput);
      const historyResult = await services.historyService.getHistoryFromLatestBoundary(
        input.workspaceId
      );
      if (!historyResult.success) {
        throw new Error(`workspace.getLatestAssistantMessage failed: ${historyResult.error}`);
      }
      for (let i = historyResult.data.length - 1; i >= 0; i--) {
        const message = historyResult.data[i];
        if (message.role !== "assistant") {
          continue;
        }
        const text = message.parts
          .filter(
            (part): part is { type: "text"; text: string } =>
              part.type === "text" && typeof (part as { text?: unknown }).text === "string"
          )
          .map((part) => part.text)
          .join("\n\n")
          .trim();
        if (text.length > 0) {
          return { found: true, messageId: message.id, text };
        }
      }
      return { found: false };
    },
  },

  "workspace.archive": {
    metadata: {
      version: 1,
      description: "Archive a workspace (idempotent; succeeds when already archived)",
      effect: "external",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
        },
        required: ["workspaceId"],
      },
      outputSchema: { type: "object" },
      timeoutMs: 120_000,
    },
    hasReconcile: true,
    createExecute: (services) => async (rawInput, ctx) => {
      const input = WorkspaceIdInputSchema.parse(rawInput);
      throwIfAborted(ctx, "workspace.archive");
      const existing = await findWorkspaceById(services, input.workspaceId);
      if (!existing) {
        throw new Error(`workspace.archive: workspace not found: ${input.workspaceId}`);
      }
      if (isWorkspaceArchived(existing.archivedAt, existing.unarchivedAt)) {
        return { archived: true, alreadyArchived: true };
      }
      throwIfAborted(ctx, "workspace.archive");
      const archiveResult = await services.workspaceService.archive(input.workspaceId);
      if (!archiveResult.success) {
        throw new Error(`workspace.archive failed: ${archiveResult.error}`);
      }
      return { archived: true, alreadyArchived: false };
    },
  },
};

function hostOnlyErrorMessage(name: string): string {
  return (
    `Workflow action ${name} requires the mux host process (backend services). ` +
    "It cannot run as a standalone child action; start the workflow from a context " +
    "with a running mux backend."
  );
}

/**
 * Generate the CJS stub source for a host action. The stub carries the real
 * metadata (statically parseable, JSON-only values) so registry listing,
 * describe(), and replay input-hashing work without special cases — only
 * execute/reconcile are intercepted in-process by the runner.
 */
function buildHostActionStubSource(
  name: string,
  definition: WorkspaceHostActionDefinition
): string {
  const throwLine = `throw new Error(${JSON.stringify(hostOnlyErrorMessage(name))});`;
  const lines = [
    `// Generated stub for mux host action "${name}".`,
    `// Real implementation: src/node/services/workflows/workspaceHostActions.ts`,
    `module.exports.metadata = ${JSON.stringify(definition.metadata, null, 2)};`,
    `module.exports.execute = async function () { ${throwLine} };`,
  ];
  if (definition.hasReconcile) {
    lines.push(`module.exports.reconcile = async function () { ${throwLine} };`);
  }
  return lines.join("\n");
}

/** Stub sources merged into BUILT_IN_WORKFLOW_ACTION_SOURCES. */
export function buildWorkspaceHostActionStubSources(): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const [name, definition] of Object.entries(WORKSPACE_HOST_ACTION_DEFINITIONS)) {
    sources[name] = buildHostActionStubSource(name, definition);
  }
  return sources;
}

/**
 * Build the in-process host action map for WorkflowActionRunner.
 * Metadata is validated eagerly (startup check) so a malformed definition
 * crashes at wiring time, not mid-workflow.
 */
export function createWorkspaceHostActions(
  services: WorkspaceHostActionServices
): ReadonlyMap<string, HostWorkflowAction> {
  const actions = new Map<string, HostWorkflowAction>();
  for (const [name, definition] of Object.entries(WORKSPACE_HOST_ACTION_DEFINITIONS)) {
    const metadata = validateWorkflowActionMetadata(definition.metadata);
    const execute = definition.createExecute(services);
    actions.set(name, {
      metadata,
      execute,
      // For idempotent actions, reconcile re-runs execute (safe by design).
      ...(definition.hasReconcile ? { reconcile: execute } : {}),
    });
  }
  return actions;
}
