import assert from "node:assert/strict";

export interface PendingDelegatedToolCall {
  toolCallId: string;
  toolName: string;
  createdAt: number;
}

interface PendingDelegatedToolCallInternal extends PendingDelegatedToolCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class DelegatedToolCallManager {
  private pendingByWorkspace = new Map<string, Map<string, PendingDelegatedToolCallInternal>>();

  registerPending(workspaceId: string, toolCallId: string, toolName: string): Promise<unknown> {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(toolCallId.length > 0, "toolCallId must be non-empty");
    assert(toolName.length > 0, "toolName must be non-empty");

    const workspaceMap = this.getOrCreateWorkspaceMap(workspaceId);
    assert(
      !workspaceMap.has(toolCallId),
      `delegated tool call already pending for toolCallId=${toolCallId}`
    );

    return new Promise<unknown>((resolve, reject) => {
      workspaceMap.set(toolCallId, {
        toolCallId,
        toolName,
        createdAt: Date.now(),
        resolve,
        reject,
      });
    }).finally(() => {
      this.deletePending(workspaceId, toolCallId);
    });
  }

  answer(workspaceId: string, toolCallId: string, result: unknown): void {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(toolCallId.length > 0, "toolCallId must be non-empty");

    const pending = this.getPending(workspaceId, toolCallId);
    pending.resolve(result);
  }

  cancel(workspaceId: string, toolCallId: string, reason: string): void {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(toolCallId.length > 0, "toolCallId must be non-empty");
    assert(reason.length > 0, "reason must be non-empty");

    const pending = this.getPending(workspaceId, toolCallId);
    pending.reject(new Error(reason));
  }

  cancelAll(workspaceId: string, reason: string): void {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");
    assert(reason.length > 0, "reason must be non-empty");

    const workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (workspaceMap == null) {
      return;
    }

    for (const toolCallId of workspaceMap.keys()) {
      this.cancel(workspaceId, toolCallId, reason);
    }
  }

  getLatestPending(workspaceId: string): PendingDelegatedToolCall | null {
    assert(workspaceId.length > 0, "workspaceId must be non-empty");

    const workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (workspaceMap == null || workspaceMap.size === 0) {
      return null;
    }

    let latest: PendingDelegatedToolCallInternal | null = null;
    for (const pending of workspaceMap.values()) {
      if (latest == null || pending.createdAt > latest.createdAt) {
        latest = pending;
      }
    }

    assert(latest != null, "Expected delegated pending entry to be non-null");
    return {
      toolCallId: latest.toolCallId,
      toolName: latest.toolName,
      createdAt: latest.createdAt,
    };
  }

  private getOrCreateWorkspaceMap(
    workspaceId: string
  ): Map<string, PendingDelegatedToolCallInternal> {
    let workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (workspaceMap == null) {
      workspaceMap = new Map();
      this.pendingByWorkspace.set(workspaceId, workspaceMap);
    }

    return workspaceMap;
  }

  private getPending(workspaceId: string, toolCallId: string): PendingDelegatedToolCallInternal {
    const workspaceMap = this.pendingByWorkspace.get(workspaceId);
    assert(workspaceMap != null, `No delegated tool calls pending for workspaceId=${workspaceId}`);

    const pending = workspaceMap.get(toolCallId);
    assert(pending != null, `No delegated tool call pending for toolCallId=${toolCallId}`);

    return pending;
  }

  private deletePending(workspaceId: string, toolCallId: string): void {
    const workspaceMap = this.pendingByWorkspace.get(workspaceId);
    if (workspaceMap == null) {
      return;
    }

    workspaceMap.delete(toolCallId);
    if (workspaceMap.size === 0) {
      this.pendingByWorkspace.delete(workspaceId);
    }
  }
}

export const delegatedToolCallManager = new DelegatedToolCallManager();
