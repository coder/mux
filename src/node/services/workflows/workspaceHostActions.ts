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

import assert from "@/common/utils/assert";
import { z } from "zod";
import type { Config } from "@/node/config";
import { detectDefaultTrunkBranch } from "@/node/git";
import type { HistoryService } from "@/node/services/historyService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import { isWorkspaceArchived } from "@/common/utils/archive";
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
  config: Pick<Config, "loadConfigOrDefault" | "findWorkspace">;
}

const AWAIT_IDLE_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const AWAIT_IDLE_MAX_TIMEOUT_MS = 10 * 60 * 1000;
const AWAIT_IDLE_POLL_MS = 500;

interface WorkspaceHostActionDefinition {
  metadata: WorkflowActionMetadata;
  hasReconcile: boolean;
  createExecute: (
    services: WorkspaceHostActionServices
  ) => (input: unknown, ctx: HostWorkflowActionContext) => Promise<unknown>;
}

const ListInputSchema = z.object({
  tagKey: z.string().min(1).nullish(),
  tagValue: z.string().nullish(),
  includeArchived: z.boolean().nullish(),
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

async function findWorkspaceByWorkItemKey(services: WorkspaceHostActionServices, key: string) {
  const all = await services.workspaceService.list();
  return all.find((metadata) => metadata.tags?.[WORK_ITEM_TAG_KEY] === key);
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
    createExecute: (services) => async (rawInput) => {
      const input = EnsureInputSchema.parse(rawInput);

      const existing = await findWorkspaceByWorkItemKey(services, input.key);
      if (existing) {
        return {
          created: false,
          workspaceId: existing.id,
          archived: isWorkspaceArchived(existing.archivedAt, existing.unarchivedAt),
        };
      }

      // Worktree/SSH runtimes require an explicit trunk; mirror the desktop
      // UI's auto-detection so callers don't have to know repo internals.
      const trunkBranch = input.trunkBranch ?? (await detectDefaultTrunkBranch(input.projectPath));
      const branchName = (input.branchName ?? input.key).replace(/[^A-Za-z0-9._/-]+/gu, "-");

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
    createExecute: (services) => async (rawInput) => {
      const input = SendMessageInputSchema.parse(rawInput);
      const agentId = input.agentId ?? "exec";

      // Model fallback: explicit input → workspace AI settings → global default.
      let model = input.model ?? undefined;
      if (model == null) {
        const all = await services.workspaceService.list();
        const metadata = all.find((entry) => entry.id === input.workspaceId);
        model = metadata?.aiSettingsByAgent?.[agentId]?.model ?? metadata?.aiSettings?.model;
        model ??= services.config.loadConfigOrDefault().defaultModel;
      }
      if (model == null) {
        throw new Error(
          "workspace.sendMessage: no model specified and no workspace/global default model configured"
        );
      }

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
      const startedAt = Date.now();

      for (;;) {
        const state = services.workspaceService.getGoalContinuationRuntimeState(input.workspaceId);
        const idle = !state.isBusy && !state.hasQueuedMessages && !state.isInitializing;
        const waitedMs = Date.now() - startedAt;
        if (idle) {
          return { idle: true, waitedMs };
        }
        if (waitedMs >= timeoutMs || ctx.abortSignal?.aborted === true) {
          return { idle: false, waitedMs };
        }
        await new Promise((resolve) => setTimeout(resolve, AWAIT_IDLE_POLL_MS));
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
    createExecute: (services) => async (rawInput) => {
      const input = WorkspaceIdInputSchema.parse(rawInput);
      const all = await services.workspaceService.list();
      const existing = all.find((metadata) => metadata.id === input.workspaceId);
      if (!existing) {
        throw new Error(`workspace.archive: workspace not found: ${input.workspaceId}`);
      }
      if (isWorkspaceArchived(existing.archivedAt, existing.unarchivedAt)) {
        return { archived: true, alreadyArchived: true };
      }
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
