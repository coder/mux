import type { Result } from "@/common/types/result";
import type { BashToolResult } from "@/common/types/tools";

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import { isGhNoPullRequestFoundOutput, parseMergeQueueEntry, PRStatusStore } from "./PRStatusStore";

const mockExecuteBash =
  jest.fn<
    (args: {
      workspaceId: string;
      script: string;
      options?: { timeout_secs?: number };
    }) => Promise<Result<BashToolResult, string>>
  >();
const mockEvaluateWorkspace =
  jest.fn<
    (input: {
      workspaceId: string;
      prState: string;
      prMergeStatus?: string;
      prIsDraft: boolean;
      prHasFailedChecks: boolean;
      prHasPendingChecks: boolean;
    }) => Promise<void>
  >();

function makeBashSuccess(output: string): Result<BashToolResult, string> {
  return {
    success: true,
    data: {
      success: true,
      output,
      exitCode: 0,
      wall_duration_ms: 0,
    },
  };
}

function makeBashFailure(output: string): Result<BashToolResult, string> {
  return {
    success: true,
    data: {
      success: false,
      output,
      error: "Command exited with code 1",
      exitCode: 1,
      wall_duration_ms: 0,
    },
  };
}

describe("isGhNoPullRequestFoundOutput", () => {
  it("matches the gh CLI no-PR message", () => {
    expect(isGhNoPullRequestFoundOutput('no pull requests found for branch "feature/test"')).toBe(
      true
    );
    expect(
      isGhNoPullRequestFoundOutput(
        'No pull requests found for branch "feature/test"\nRun gh pr create to open one.'
      )
    ).toBe(true);
  });

  it("ignores other failures", () => {
    expect(isGhNoPullRequestFoundOutput("HTTP 502 from api.github.com")).toBe(false);
    expect(isGhNoPullRequestFoundOutput(undefined)).toBe(false);
  });
});

describe("parseMergeQueueEntry", () => {
  it("returns null for null and undefined", () => {
    expect(parseMergeQueueEntry(null)).toBeNull();
    expect(parseMergeQueueEntry(undefined)).toBeNull();
  });

  it("returns null for non-object values", () => {
    expect(parseMergeQueueEntry("queue")).toBeNull();
    expect(parseMergeQueueEntry(42)).toBeNull();
    expect(parseMergeQueueEntry(true)).toBeNull();
  });

  it("parses valid merge queue entry", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 0 })).toEqual({
      state: "QUEUED",
      position: 0,
    });
  });

  it("allows null position", () => {
    expect(parseMergeQueueEntry({ state: "AWAITING_CHECKS", position: null })).toEqual({
      state: "AWAITING_CHECKS",
      position: null,
    });
  });

  it("defaults state to QUEUED when absent", () => {
    expect(parseMergeQueueEntry({ position: 2 })).toEqual({
      state: "QUEUED",
      position: 2,
    });
  });

  it("normalizes invalid position values to null", () => {
    expect(parseMergeQueueEntry({ state: "QUEUED", position: -1 })).toEqual({
      state: "QUEUED",
      position: null,
    });
    expect(parseMergeQueueEntry({ state: "QUEUED", position: 1.5 })).toEqual({
      state: "QUEUED",
      position: null,
    });
    expect(parseMergeQueueEntry({ state: "QUEUED", position: "0" })).toEqual({
      state: "QUEUED",
      position: null,
    });
  });
});

describe("PRStatusStore gh pr view failures", () => {
  let store: PRStatusStore;

  beforeEach(() => {
    mockExecuteBash.mockReset();
    mockEvaluateWorkspace.mockReset();
    mockEvaluateWorkspace.mockResolvedValue(undefined);

    store = new PRStatusStore();
    store.setClient({
      workspace: {
        executeBash: mockExecuteBash,
      },
      projects: {
        sections: {
          evaluateWorkspace: mockEvaluateWorkspace,
        },
      },
    } as unknown as Parameters<PRStatusStore["setClient"]>[0]);
  });

  afterEach(() => {
    store.dispose();
  });

  it("treats the gh no-PR failure as a real no-PR state", async () => {
    mockExecuteBash.mockResolvedValue(
      makeBashFailure('no pull requests found for branch "feature/test"')
    );

    await (
      store as unknown as { detectWorkspacePR: (workspaceId: string) => Promise<void> }
    ).detectWorkspacePR("ws-1");

    const entry = store.getWorkspacePR("ws-1");
    expect(entry?.prLink).toBeNull();
    expect(entry?.error).toBeUndefined();
    expect(entry?.loading).toBe(false);
    expect(mockEvaluateWorkspace).toHaveBeenCalledTimes(1);
    expect(mockEvaluateWorkspace).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      prState: "none",
      prMergeStatus: undefined,
      prIsDraft: false,
      prHasFailedChecks: false,
      prHasPendingChecks: false,
    });

    const executeBashArgs = mockExecuteBash.mock.calls[0]?.[0];
    expect(executeBashArgs?.script).toContain("gh pr view --json");
    expect(executeBashArgs?.script).not.toContain("|| echo");
  });

  it("keeps other gh failures on the error path without re-evaluating sections", async () => {
    mockExecuteBash.mockResolvedValue(makeBashFailure("HTTP 502 from api.github.com"));

    await (
      store as unknown as { detectWorkspacePR: (workspaceId: string) => Promise<void> }
    ).detectWorkspacePR("ws-1");

    const entry = store.getWorkspacePR("ws-1");
    expect(entry?.prLink).toBeNull();
    expect(entry?.error).toBe("Failed to run gh CLI");
    expect(entry?.loading).toBe(false);
    expect(mockEvaluateWorkspace).not.toHaveBeenCalled();
  });

  it("still parses successful gh pr view responses", async () => {
    mockExecuteBash.mockResolvedValue(
      makeBashSuccess(
        JSON.stringify({
          number: 42,
          url: "https://github.com/coder/mux/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          title: "Fix PR detection",
          isDraft: false,
          headRefName: "feature/test",
          baseRefName: "main",
          statusCheckRollup: [],
        })
      )
    );

    await (
      store as unknown as { detectWorkspacePR: (workspaceId: string) => Promise<void> }
    ).detectWorkspacePR("ws-1");

    const entry = store.getWorkspacePR("ws-1");
    expect(entry?.prLink?.url).toBe("https://github.com/coder/mux/pull/42");
    expect(entry?.status?.state).toBe("OPEN");
    expect(entry?.error).toBeUndefined();
  });
});
