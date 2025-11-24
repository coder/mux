import { createTempGitRepo, cleanupTempGitRepo } from "./helpers";
import { setupWorkspace, setupWorkspaceWithoutProvider } from "./setup";
import type { TestEnvironment } from "./setup";

let sharedRepoPath: string | undefined;

export interface SharedWorkspaceContext {
  env: TestEnvironment;
  workspaceId: string;
  workspacePath: string;
  branchName: string;
  tempGitRepo: string;
}

export async function createSharedRepo(): Promise<void> {
  if (!sharedRepoPath) {
    sharedRepoPath = await createTempGitRepo();
  }
}

export async function cleanupSharedRepo(): Promise<void> {
  if (sharedRepoPath) {
    await cleanupTempGitRepo(sharedRepoPath);
    sharedRepoPath = undefined;
  }
}

export async function withSharedWorkspace(
  provider: string,
  testFn: (context: SharedWorkspaceContext) => Promise<void>
): Promise<void> {
  if (!sharedRepoPath) {
    throw new Error("Shared repo has not been created yet.");
  }

  const { env, workspaceId, workspacePath, branchName, tempGitRepo, cleanup } =
    await setupWorkspace(provider, undefined, sharedRepoPath);

  try {
    await testFn({ env, workspaceId, workspacePath, branchName, tempGitRepo });
  } finally {
    await cleanup();
  }
}

export async function withSharedWorkspaceNoProvider(
  testFn: (context: SharedWorkspaceContext) => Promise<void>
): Promise<void> {
  if (!sharedRepoPath) {
    throw new Error("Shared repo has not been created yet.");
  }

  const { env, workspaceId, workspacePath, branchName, tempGitRepo, cleanup } =
    await setupWorkspaceWithoutProvider(undefined, sharedRepoPath);

  try {
    await testFn({ env, workspaceId, workspacePath, branchName, tempGitRepo });
  } finally {
    await cleanup();
  }
}
