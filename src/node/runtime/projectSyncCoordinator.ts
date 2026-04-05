interface ProjectSyncOptions {
  projectKey: string;
  snapshotKey: string;
  abortSignal?: AbortSignal;
}

interface InflightSnapshotSync {
  promise: Promise<void>;
  abortController: AbortController;
  waiters: number;
}

export class ProjectSyncCoordinator {
  private readonly inflightSyncs = new Map<string, InflightSnapshotSync>();
  private readonly projectTails = new Map<string, Promise<void>>();

  async runSnapshotSync(
    options: ProjectSyncOptions,
    fn: (abortSignal: AbortSignal) => Promise<void>
  ): Promise<void> {
    if (options.abortSignal?.aborted) {
      throw new Error("Operation aborted");
    }

    let inflight = this.inflightSyncs.get(options.snapshotKey);
    if (inflight?.abortController.signal.aborted && inflight.waiters === 0) {
      this.inflightSyncs.delete(options.snapshotKey);
      inflight = undefined;
    }

    if (!inflight) {
      const abortController = new AbortController();
      const promise = this.enqueueProjectMutation(options.projectKey, () =>
        fn(abortController.signal)
      );
      inflight = {
        promise,
        abortController,
        waiters: 0,
      };
      this.inflightSyncs.set(options.snapshotKey, inflight);
      void promise.then(
        () => {
          if (this.inflightSyncs.get(options.snapshotKey) === inflight) {
            this.inflightSyncs.delete(options.snapshotKey);
          }
        },
        () => {
          if (this.inflightSyncs.get(options.snapshotKey) === inflight) {
            this.inflightSyncs.delete(options.snapshotKey);
          }
        }
      );
    }

    inflight.waiters += 1;
    let released = false;
    const releaseWaiter = () => {
      if (released) {
        return;
      }
      released = true;
      inflight.waiters = Math.max(0, inflight.waiters - 1);
      if (inflight.waiters === 0 && !inflight.abortController.signal.aborted) {
        inflight.abortController.abort();
      }
    };

    const callerAbortSignal = options.abortSignal;
    let onAbort: (() => void) | undefined;
    const callerAbort = callerAbortSignal
      ? new Promise<never>((_, reject) => {
          onAbort = () => {
            releaseWaiter();
            reject(new Error("Operation aborted"));
          };
          if (callerAbortSignal.aborted) {
            onAbort();
            return;
          }
          callerAbortSignal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;

    try {
      if (callerAbort) {
        await Promise.race([inflight.promise, callerAbort]);
      } else {
        await inflight.promise;
      }
    } finally {
      if (onAbort) {
        options.abortSignal?.removeEventListener("abort", onAbort);
      }
      releaseWaiter();
    }
  }

  async enqueueProjectMutation(projectKey: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.projectTails.get(projectKey) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current
    );
    this.projectTails.set(projectKey, tail);

    try {
      await previous.catch(() => undefined);
      await fn();
    } finally {
      releaseCurrent?.();
      if (this.projectTails.get(projectKey) === tail) {
        this.projectTails.delete(projectKey);
      }
    }
  }

  clearAll(): void {
    this.inflightSyncs.clear();
    this.projectTails.clear();
  }
}

export const projectSyncCoordinator = new ProjectSyncCoordinator();
