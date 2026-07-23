import { describe, expect, test } from "bun:test";
import { isConcurrentLocalWorkspaceActive } from "./ConcurrentLocalWarning";

describe("isConcurrentLocalWorkspaceActive", () => {
  test("stays active across a background monitor wake cycle", () => {
    const wakeCycle = [
      {
        canInterrupt: true,
        isStarting: false,
        pendingBackgroundWake: false,
        activeWorkflowRunCount: 0,
        activeBashMonitorCount: 1,
      },
      {
        canInterrupt: false,
        isStarting: false,
        pendingBackgroundWake: true,
        activeWorkflowRunCount: 0,
        activeBashMonitorCount: 0,
      },
      {
        canInterrupt: false,
        isStarting: true,
        pendingBackgroundWake: true,
        activeWorkflowRunCount: 0,
        activeBashMonitorCount: 0,
      },
      {
        canInterrupt: true,
        isStarting: false,
        pendingBackgroundWake: false,
        activeWorkflowRunCount: 0,
        activeBashMonitorCount: 0,
      },
    ];

    expect(wakeCycle.map(isConcurrentLocalWorkspaceActive)).toEqual([true, true, true, true]);
  });

  test("stays active while a background workflow can wake the agent", () => {
    expect(
      isConcurrentLocalWorkspaceActive({
        canInterrupt: false,
        isStarting: false,
        pendingBackgroundWake: false,
        activeWorkflowRunCount: 1,
        activeBashMonitorCount: 0,
      })
    ).toBe(true);
  });

  test("is inactive once no stream, startup, or wake monitor remains", () => {
    expect(
      isConcurrentLocalWorkspaceActive({
        canInterrupt: false,
        isStarting: false,
        pendingBackgroundWake: false,
        activeWorkflowRunCount: 0,
        activeBashMonitorCount: 0,
      })
    ).toBe(false);
  });
});
