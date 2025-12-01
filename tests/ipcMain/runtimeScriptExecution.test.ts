import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "./setup";
import { IPC_CHANNELS } from "../../src/common/constants/ipc-constants";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  createWorkspaceWithInit,
  generateBranchName,
  TEST_TIMEOUT_LOCAL_MS,
  TEST_TIMEOUT_SSH_MS,
} from "./helpers";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "../runtime/ssh-fixture";
import type { RuntimeConfig } from "../../src/common/types/runtime";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

let sshConfig: SSHServerConfig | undefined;

describeIntegration("Workspace script execution", () => {
  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error(
        "Docker is required for SSH runtime tests. Please install Docker or skip tests by unsetting TEST_INTEGRATION."
      );
    }

    sshConfig = await startSSHServer();
  }, 60000);

  afterAll(async () => {
    if (sshConfig) {
      await stopSSHServer(sshConfig);
    }
  }, 30000);

  describe.each<{ type: "local" | "ssh" }>([{ type: "local" }, { type: "ssh" }])(
    "Runtime: $type",
    ({ type }) => {
      const getRuntimeConfig = (branchName: string): RuntimeConfig | undefined => {
        if (type === "ssh" && sshConfig) {
          return {
            type: "ssh",
            host: `testuser@localhost`,
            srcBaseDir: `${sshConfig.workdir}/${branchName}`,
            identityFile: sshConfig.privateKeyPath,
            port: sshConfig.port,
          };
        }

        return undefined; // undefined => local runtime
      };

      test.concurrent(
        "captures stdout as agent-visible output",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const branchName = generateBranchName("script-runtime");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true,
              type === "ssh"
            );

            try {
              const scriptName = "runtime-demo";
              const scriptSetup = `
mkdir -p .mux/scripts
cat <<'EOF' > .mux/scripts/${scriptName}
#!/usr/bin/env bash
set -euo pipefail

# stdout goes to agent
echo "Agent-visible output from script"
EOF
chmod +x .mux/scripts/${scriptName}
`;

              const setupResult = await env.mockIpcRenderer.invoke(
                IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
                workspaceId,
                scriptSetup
              );

              expect(setupResult.success).toBe(true);
              expect(setupResult.data.success).toBe(true);

              const executionResult = await env.mockIpcRenderer.invoke(
                IPC_CHANNELS.WORKSPACE_EXECUTE_SCRIPT,
                workspaceId,
                scriptName
              );

              expect(executionResult.success).toBe(true);
              expect(executionResult.data.success).toBe(true);
              expect(executionResult.data.exitCode).toBe(0);
              expect(executionResult.data.output).toContain("Agent-visible output from script");
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );

      test.concurrent(
        "captures stdout from legacy .cmux/scripts path",
        async () => {
          const env = await createTestEnvironment();
          const tempGitRepo = await createTempGitRepo();

          try {
            const branchName = generateBranchName("script-runtime-legacy");
            const runtimeConfig = getRuntimeConfig(branchName);
            const { workspaceId, cleanup } = await createWorkspaceWithInit(
              env,
              tempGitRepo,
              branchName,
              runtimeConfig,
              true,
              type === "ssh"
            );

            try {
              const scriptName = "runtime-demo-legacy";
              const scriptSetup = `
mkdir -p .cmux/scripts
cat <<'EOF' > .cmux/scripts/${scriptName}
#!/usr/bin/env bash
set -euo pipefail

echo "Legacy path output"
EOF
chmod +x .cmux/scripts/${scriptName}
`;

              const setupResult = await env.mockIpcRenderer.invoke(
                IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
                workspaceId,
                scriptSetup
              );

              expect(setupResult.success).toBe(true);
              expect(setupResult.data.success).toBe(true);

              const executionResult = await env.mockIpcRenderer.invoke(
                IPC_CHANNELS.WORKSPACE_EXECUTE_SCRIPT,
                workspaceId,
                scriptName
              );

              expect(executionResult.success).toBe(true);
              expect(executionResult.data.success).toBe(true);
              expect(executionResult.data.exitCode).toBe(0);
              expect(executionResult.data.output).toContain("Legacy path output");
            } finally {
              await cleanup();
            }
          } finally {
            await cleanupTempGitRepo(tempGitRepo);
            await cleanupTestEnvironment(env);
          }
        },
        type === "ssh" ? TEST_TIMEOUT_SSH_MS : TEST_TIMEOUT_LOCAL_MS
      );
    }
  );
});
