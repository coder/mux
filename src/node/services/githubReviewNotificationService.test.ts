import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { Ok } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceService } from "./workspaceService";
import {
  GitHubReviewNotificationService,
  formatGitHubReviewNotification,
  isGitHubNoPullRequestOutput,
  parseGitHubReviewCommandOutput,
  reconcileGitHubReviewCheckpoint,
  type GitHubPullRequestReview,
  type GitHubPullRequestSnapshot,
} from "./githubReviewNotificationService";

const snapshot: GitHubPullRequestSnapshot = {
  prKey: "https://github.com/coder/mux/pull/42",
  prUrl: "https://github.com/coder/mux/pull/42",
  number: 42,
  reviews: [],
};

const workspace = {
  id: "workspace-1",
  name: "feature/reviews",
  projectName: "mux",
  projectPath: "/tmp/mux",
  namedWorkspacePath: "/tmp/mux/feature-reviews",
  runtimeConfig: { type: "local" },
  githubReviewNotificationsEnabled: true,
} satisfies FrontendWorkspaceMetadata;

type WorkspaceServiceSendMessageArgs = Parameters<WorkspaceService["sendMessage"]>;
type WorkspaceServiceSendMessageInternal = NonNullable<WorkspaceServiceSendMessageArgs[3]>;
type WorkspaceServiceSendMessageResult = Awaited<ReturnType<WorkspaceService["sendMessage"]>>;
type WorkspaceServiceExecuteBashArgs = Parameters<WorkspaceService["executeBash"]>;
type WorkspaceServiceExecuteBashResult = Awaited<ReturnType<WorkspaceService["executeBash"]>>;
type WorkspaceServiceSendOptions = NonNullable<
  ReturnType<WorkspaceService["getGoalContinuationKickoffSendOptions"]>
>;

function githubReviewCommandOutput(reviews: GitHubPullRequestReview[]): string {
  return JSON.stringify({
    number: snapshot.number,
    url: snapshot.prUrl,
    reviews: reviews.map((review) => ({
      id: review.id,
      author: { login: review.author },
      body: review.body,
      state: review.state,
      submittedAt: review.submittedAt,
    })),
  });
}

async function createNotificationServiceHarness() {
  const sessionDir = await mkdtemp(join(tmpdir(), "mux-github-review-notifications-"));
  let commandResult: WorkspaceServiceExecuteBashResult = Ok({
    success: true as const,
    output: githubReviewCommandOutput([]),
    exitCode: 0,
    wall_duration_ms: 1,
  });
  let notificationsEnabled = true;
  const sends: Array<{
    message: string;
    internal: WorkspaceServiceSendMessageInternal | undefined;
  }> = [];

  const workspaceService = {
    list: (): Promise<FrontendWorkspaceMetadata[]> => Promise.resolve([workspace]),
    executeBash: (
      ..._args: WorkspaceServiceExecuteBashArgs
    ): Promise<WorkspaceServiceExecuteBashResult> => Promise.resolve(commandResult),
    getGoalContinuationKickoffSendOptions: (): WorkspaceServiceSendOptions => ({
      model: "openai:gpt-5.6-luna",
      agentId: "exec",
    }),
    getRuntimeStatuses: (workspaceIds: string[]) =>
      Promise.resolve(Object.fromEntries(workspaceIds.map((id) => [id, "running" as const]))),
    getGitHubReviewNotificationsEnabled: () => notificationsEnabled,
    sendMessage: (
      ...args: WorkspaceServiceSendMessageArgs
    ): Promise<WorkspaceServiceSendMessageResult> => {
      sends.push({ message: args[1], internal: args[3] });
      return Promise.resolve(Ok(undefined));
    },
  };

  const dependencies = {
    config: {
      getSessionDir: () => sessionDir,
    },
    experimentsService: {
      isExperimentEnabled: () => true,
    },
    workspaceService,
  };
  const createService = () => new GitHubReviewNotificationService(dependencies);

  return {
    service: createService(),
    createService,
    sends,
    setNotificationsEnabled(enabled: boolean) {
      notificationsEnabled = enabled;
    },
    setReviews(reviews: GitHubPullRequestReview[]) {
      commandResult = Ok({
        success: true as const,
        output: githubReviewCommandOutput(reviews),
        exitCode: 0,
        wall_duration_ms: 1,
      });
    },
    setCommandFailure(output: string) {
      commandResult = Ok({
        success: false as const,
        output,
        exitCode: 1,
        error: "Command exited with code 1",
        wall_duration_ms: 1,
      });
    },
    async cleanup() {
      await rm(sessionDir, { recursive: true, force: true });
    },
  };
}

function review(id: string, author = id): GitHubPullRequestReview {
  return {
    id,
    author,
    body: `${id} body`,
    state: "COMMENTED",
    submittedAt: "2026-08-14T04:00:00Z",
  };
}

describe("GitHub review notification parsing", () => {
  test("parses submitted reviews and ignores pending reviews", () => {
    const result = parseGitHubReviewCommandOutput(
      JSON.stringify({
        number: 42,
        url: snapshot.prUrl,
        reviews: [
          {
            id: "review-1",
            author: { login: "reviewer" },
            body: "Please add a test.",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-08-14T04:00:00Z",
          },
          {
            id: "review-2",
            author: { login: "draft-reviewer" },
            body: "Draft",
            state: "PENDING",
            submittedAt: null,
          },
        ],
      })
    );

    expect(result).toEqual({
      kind: "pull-request",
      snapshot: {
        ...snapshot,
        reviews: [
          {
            id: "review-1",
            author: "reviewer",
            body: "Please add a test.",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-08-14T04:00:00Z",
          },
        ],
      },
    });
  });

  test("recognizes the no-pull-request response", () => {
    expect(parseGitHubReviewCommandOutput('{"no_pr":true}')).toEqual({ kind: "no-pr" });
  });
  test("only treats an explicit no-pull-request error as no pull request", () => {
    expect(isGitHubNoPullRequestOutput("no pull requests found for branch feature/reviews")).toBe(
      true
    );
    expect(isGitHubNoPullRequestOutput("authentication failed")).toBe(false);
  });
});

describe("GitHub review notification checkpoints", () => {
  test("baselines an existing pull request and reports only later review IDs", () => {
    const initial = reconcileGitHubReviewCheckpoint(null, {
      ...snapshot,
      reviews: [
        {
          id: "old-review",
          author: "old-reviewer",
          body: "Existing review",
          state: "COMMENTED",
          submittedAt: "2026-08-13T04:00:00Z",
        },
      ],
    });

    expect(initial.baseline).toBe(true);
    expect(initial.checkpoint.pendingReviews).toEqual([]);
    expect(initial.checkpoint.knownReviewIds).toEqual(["old-review"]);

    const next = reconcileGitHubReviewCheckpoint(initial.checkpoint, {
      ...snapshot,
      reviews: [
        {
          id: "old-review",
          author: "old-reviewer",
          body: "Existing review",
          state: "COMMENTED",
          submittedAt: "2026-08-13T04:00:00Z",
        },
        {
          id: "new-review",
          author: "new-reviewer",
          body: "New review",
          state: "APPROVED",
          submittedAt: "2026-08-14T04:00:00Z",
        },
      ],
    });

    expect(next.baseline).toBe(false);
    expect(next.checkpoint.pendingReviews.map((review) => review.id)).toEqual(["new-review"]);
  });

  test("resets the baseline when the linked pull request changes", () => {
    const result = reconcileGitHubReviewCheckpoint(
      {
        version: 1,
        prKey: snapshot.prKey,
        knownReviewIds: ["old-review"],
        pendingReviews: [],
      },
      {
        ...snapshot,
        prKey: "https://github.com/coder/mux/pull/43",
        prUrl: "https://github.com/coder/mux/pull/43",
        number: 43,
        reviews: [
          {
            id: "review-on-new-pr",
            author: "reviewer",
            body: "Existing review",
            state: "COMMENTED",
            submittedAt: "2026-08-14T04:00:00Z",
          },
        ],
      }
    );

    expect(result.baseline).toBe(true);
    expect(result.checkpoint.knownReviewIds).toEqual(["review-on-new-pr"]);
    expect(result.checkpoint.pendingReviews).toEqual([]);
  });
});

test("preserves the checkpoint when the GitHub query fails", async () => {
  const harness = await createNotificationServiceHarness();
  const existingReview = review("existing-review");
  const newReview = review("new-review");

  try {
    harness.setReviews([existingReview]);
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(0);

    harness.setCommandFailure("temporary network failure");
    await harness.service.pollOnce();

    harness.setReviews([existingReview, newReview]);
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]?.message).toContain("new-review body");
  } finally {
    await harness.cleanup();
  }
});

test("re-baselines after notifications are disabled and re-enabled", async () => {
  const harness = await createNotificationServiceHarness();
  const existingReview = review("existing-review");
  const disabledReview = review("disabled-review");

  try {
    harness.setReviews([existingReview]);
    await harness.service.pollOnce();

    harness.setReviews([existingReview, disabledReview]);
    harness.setNotificationsEnabled(false);
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(0);

    harness.setNotificationsEnabled(true);
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(0);
  } finally {
    await harness.cleanup();
  }
});

test("keeps reviews pending after a pre-stream failure", async () => {
  const harness = await createNotificationServiceHarness();
  const existingReview = review("existing-review");
  const newReview = review("new-review");

  try {
    harness.setReviews([existingReview]);
    await harness.service.pollOnce();

    harness.setReviews([existingReview, newReview]);
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(1);

    const internal = harness.sends[0]?.internal;
    await internal?.onAcceptedPreStreamFailure?.({ type: "unknown", raw: "startup failed" });

    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(2);
    expect(harness.sends[1]?.message).toContain("new-review body");
  } finally {
    await harness.cleanup();
  }
});

test("retries pending reviews after the service restarts before stream startup", async () => {
  const harness = await createNotificationServiceHarness();
  const existingReview = review("existing-review");
  const newReview = review("new-review");

  try {
    harness.setReviews([existingReview]);
    await harness.service.pollOnce();

    harness.setReviews([existingReview, newReview]);
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(1);

    const restartedService = harness.createService();
    await restartedService.pollOnce();
    expect(harness.sends).toHaveLength(2);
    expect(harness.sends[1]?.message).toContain("new-review body");
  } finally {
    await harness.cleanup();
  }
});

test("does not retry a review after stream startup confirms delivery", async () => {
  const harness = await createNotificationServiceHarness();
  const existingReview = review("existing-review");
  const newReview = review("new-review");

  try {
    harness.setReviews([existingReview]);
    await harness.service.pollOnce();

    harness.setReviews([existingReview, newReview]);
    await harness.service.pollOnce();
    await harness.sends[0]?.internal?.onStreamStarted?.();

    const restartedService = harness.createService();
    await restartedService.pollOnce();
    expect(harness.sends).toHaveLength(1);
  } finally {
    await harness.cleanup();
  }
});

test("continues polling later workspaces after one workspace fails", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "mux-github-review-notifications-"));
  const firstWorkspace = workspace;
  const secondWorkspace = {
    ...workspace,
    id: "workspace-2",
    name: "feature/reviews-2",
  } satisfies FrontendWorkspaceMetadata;
  const existingReview = review("second-existing");
  const newReview = review("second-new");
  let secondOutput = githubReviewCommandOutput([existingReview]);
  const sends: string[] = [];

  const workspaceService = {
    list: (): Promise<FrontendWorkspaceMetadata[]> =>
      Promise.resolve([firstWorkspace, secondWorkspace]),
    executeBash: (
      ...args: WorkspaceServiceExecuteBashArgs
    ): Promise<WorkspaceServiceExecuteBashResult> => {
      const workspaceId = args[0];
      if (workspaceId === firstWorkspace.id) {
        return Promise.reject(new Error("checkpoint runtime failed"));
      }
      return Promise.resolve(
        Ok({
          success: true as const,
          output: secondOutput,
          exitCode: 0,
          wall_duration_ms: 1,
        })
      );
    },
    getGoalContinuationKickoffSendOptions: (): WorkspaceServiceSendOptions => ({
      model: "openai:gpt-5.6-luna",
      agentId: "exec",
    }),
    getRuntimeStatuses: (workspaceIds: string[]) =>
      Promise.resolve(Object.fromEntries(workspaceIds.map((id) => [id, "running" as const]))),
    getGitHubReviewNotificationsEnabled: () => true,
    sendMessage: (
      ...args: WorkspaceServiceSendMessageArgs
    ): Promise<WorkspaceServiceSendMessageResult> => {
      sends.push(args[1]);
      return Promise.resolve(Ok(undefined));
    },
  };
  const service = new GitHubReviewNotificationService({
    config: {
      getSessionDir: (workspaceId: string) => join(sessionDir, workspaceId),
    },
    experimentsService: {
      isExperimentEnabled: () => true,
    },
    workspaceService,
  });

  try {
    await service.pollOnce();
    expect(sends).toHaveLength(0);

    secondOutput = githubReviewCommandOutput([existingReview, newReview]);
    await service.pollOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("second-new body");
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("does not wake stopped or remote runtimes during polling", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "mux-github-review-notifications-"));
  const devcontainerWorkspace = {
    ...workspace,
    id: "workspace-devcontainer",
    runtimeConfig: {
      type: "devcontainer",
      configPath: ".devcontainer/devcontainer.json",
    },
  } satisfies FrontendWorkspaceMetadata;
  const runningDevcontainerWorkspace = {
    ...devcontainerWorkspace,
    id: "workspace-devcontainer-running",
  } satisfies FrontendWorkspaceMetadata;
  const sshWorkspace = {
    ...workspace,
    id: "workspace-ssh",
    runtimeConfig: {
      type: "ssh",
      host: "example.com",
      srcBaseDir: "/tmp/src",
    },
  } satisfies FrontendWorkspaceMetadata;
  const dockerWorkspace = {
    ...workspace,
    id: "workspace-docker",
    runtimeConfig: {
      type: "docker",
      image: "ubuntu:24.04",
    },
  } satisfies FrontendWorkspaceMetadata;
  const multiProjectDevcontainerWorkspace = {
    ...workspace,
    id: "workspace-multi-project-devcontainer",
    runtimeConfig: {
      type: "devcontainer",
      configPath: ".devcontainer/devcontainer.json",
    },
    projects: [
      { projectPath: "/tmp/project-a", projectName: "project-a" },
      { projectPath: "/tmp/project-b", projectName: "project-b" },
    ],
  } satisfies FrontendWorkspaceMetadata;
  let executeBashCalls = 0;

  const workspaceService = {
    list: (): Promise<FrontendWorkspaceMetadata[]> =>
      Promise.resolve([
        devcontainerWorkspace,
        runningDevcontainerWorkspace,
        sshWorkspace,
        dockerWorkspace,
        multiProjectDevcontainerWorkspace,
      ]),
    executeBash: (
      ..._args: WorkspaceServiceExecuteBashArgs
    ): Promise<WorkspaceServiceExecuteBashResult> => {
      executeBashCalls += 1;
      return Promise.resolve(
        Ok({
          success: true as const,
          output: githubReviewCommandOutput([]),
          exitCode: 0,
          wall_duration_ms: 1,
        })
      );
    },
    getGoalContinuationKickoffSendOptions: (): WorkspaceServiceSendOptions => ({
      model: "openai:gpt-5.6-luna",
      agentId: "exec",
    }),
    getRuntimeStatuses: (workspaceIds: string[]) =>
      Promise.resolve(
        Object.fromEntries(
          workspaceIds.map((id) => [
            id,
            id === runningDevcontainerWorkspace.id ? ("running" as const) : ("stopped" as const),
          ])
        )
      ),
    getGitHubReviewNotificationsEnabled: () => true,
    sendMessage: (
      ..._args: WorkspaceServiceSendMessageArgs
    ): Promise<WorkspaceServiceSendMessageResult> => Promise.resolve(Ok(undefined)),
  };
  const service = new GitHubReviewNotificationService({
    config: {
      getSessionDir: (workspaceId: string) => join(sessionDir, workspaceId),
    },
    experimentsService: {
      isExperimentEnabled: () => true,
    },
    workspaceService,
  });

  try {
    await service.pollOnce();
    expect(executeBashCalls).toBe(1);
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("keeps queued reviews pending until stream startup and retries canceled batches", async () => {
  const harness = await createNotificationServiceHarness();
  const existingReview = review("existing-review");
  const newReview = review("new-review", "reviewer");
  const laterReview = review("later-review", "second-reviewer");

  try {
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(0);

    harness.setReviews([existingReview, newReview]);
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(1);

    // A queued batch stays in flight, so a later poll does not enqueue a duplicate.
    harness.setReviews([existingReview, newReview, laterReview]);
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(1);

    // A later review stays pending while the earlier batch is in flight.
    const firstInternal = harness.sends[0]?.internal;
    expect(firstInternal?.onStreamStarted).toBeDefined();
    await firstInternal?.onStreamStarted?.();
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(2);

    // Cancellation leaves the later durable pending review available for retry.
    const secondInternal = harness.sends[1]?.internal;
    expect(secondInternal?.onCanceled).toBeDefined();
    await secondInternal?.onCanceled?.("test cancellation");
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(3);

    const thirdInternal = harness.sends[2]?.internal;
    expect(thirdInternal?.onStreamStarted).toBeDefined();
    await thirdInternal?.onStreamStarted?.();
    await harness.service.pollOnce();
    expect(harness.sends).toHaveLength(3);
  } finally {
    await harness.cleanup();
  }
});

test("formats one notification for multiple new reviews", () => {
  const message = formatGitHubReviewNotification(snapshot, [
    {
      id: "review-1",
      author: "reviewer-a",
      body: "First review",
      state: "COMMENTED",
      submittedAt: "2026-08-14T04:00:00Z",
    },
    {
      id: "review-2",
      author: "reviewer-b",
      body: "Second review",
      state: "APPROVED",
      submittedAt: "2026-08-14T04:01:00Z",
    },
  ]);

  expect(message).toContain("pull request #42");
  expect(message).toContain("reviewer-a");
  expect(message).toContain("reviewer-b");
  expect(message).toContain("First review");
  expect(message).toContain("Second review");
});
