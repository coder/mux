import { describe, expect, test } from "bun:test";
import { ProjectSyncCoordinator } from "./projectSyncCoordinator";

describe("ProjectSyncCoordinator", () => {
  test("does not let one aborted caller cancel other waiters on the same snapshot", async () => {
    const coordinator = new ProjectSyncCoordinator();
    const firstAbort = new AbortController();
    let releaseSharedWork: (() => void) | undefined;
    let runCount = 0;

    const firstPromise = coordinator.runSnapshotSync(
      {
        projectKey: "project-a",
        snapshotKey: "snapshot-a",
        abortSignal: firstAbort.signal,
      },
      async (sharedAbortSignal) => {
        runCount += 1;
        return await new Promise<void>((resolve, reject) => {
          releaseSharedWork = resolve;
          sharedAbortSignal.addEventListener("abort", () => reject(new Error("shared aborted")), {
            once: true,
          });
        });
      }
    );

    const secondPromise = coordinator.runSnapshotSync(
      {
        projectKey: "project-a",
        snapshotKey: "snapshot-a",
      },
      () => Promise.reject(new Error("expected existing snapshot sync to be reused"))
    );

    firstAbort.abort();
    try {
      await firstPromise;
      throw new Error("Expected first waiter to abort");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Operation aborted");
    }
    expect(runCount).toBe(1);

    releaseSharedWork?.();
    await secondPromise;
  });

  test("returns promptly when the last waiter aborts", async () => {
    const coordinator = new ProjectSyncCoordinator();
    const abortController = new AbortController();

    const resultPromise = coordinator.runSnapshotSync(
      {
        projectKey: "project-b",
        snapshotKey: "snapshot-b",
        abortSignal: abortController.signal,
      },
      async (sharedAbortSignal) => {
        return await new Promise<void>((_resolve, reject) => {
          sharedAbortSignal.addEventListener("abort", () => reject(new Error("shared aborted")), {
            once: true,
          });
        });
      }
    );

    abortController.abort();
    try {
      await resultPromise;
      throw new Error("Expected the caller to abort");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Operation aborted");
    }
  });
});
