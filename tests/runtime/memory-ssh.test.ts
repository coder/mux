/**
 * Memory project-scope integration test against a real SSHRuntime.
 *
 * Gate G1 step 5 (agent memory plan): project-scope create/view round-trip
 * must work through the Runtime abstraction over SSH. Uses the same Docker
 * sshd fixture as runtime.test.ts; gated behind TEST_INTEGRATION.
 */

import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import { Config } from "@/node/config";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService, type MemoryScopeContext } from "@/node/services/memoryService";
import { execBuffered } from "@/node/utils/runtime/helpers";

function shouldRunIntegrationTests(): boolean {
  return process.env.TEST_INTEGRATION === "1" || process.env.TEST_INTEGRATION === "true";
}

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

let sshConfig: SSHServerConfig | undefined;

describeIntegration("MemoryService project scope over SSHRuntime", () => {
  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error("Docker is required for SSH integration tests.");
    }
    console.log("fixture: starting sshd...");
    sshConfig = await startSSHServer();
    console.log("fixture: sshd ready on port", sshConfig.port);
  }, 120000);

  afterAll(async () => {
    if (sshConfig) {
      await stopSSHServer(sshConfig);
    }
  });

  test("create/view/strReplace round-trip on a remote checkout", async () => {
    if (!sshConfig) throw new Error("SSH config unavailable");

    const runtimeConfig = {
      host: "testuser@localhost",
      srcBaseDir: sshConfig.workdir,
      identityFile: sshConfig.privateKeyPath,
      port: sshConfig.port,
    };
    // NOTE: like all tests under tests/, this must run via jest
    // (TEST_INTEGRATION=1 bun x jest tests/runtime/memory-ssh.test.ts),
    // not `bun test` — see the Makefile test-integration target.
    const runtime = new SSHRuntime(runtimeConfig, createSSHTransport(runtimeConfig, false));

    // Remote checkout dir for the fake project.
    const checkoutCwd = `${sshConfig.workdir}/memory-ssh-checkout`;
    await execBuffered(runtime, `mkdir -p ${checkoutCwd}`, { cwd: sshConfig.workdir, timeout: 30 });

    const muxHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), "memory-ssh-home-"));
    try {
      const config = new Config(muxHome);
      const service = new MemoryService(config, new MemoryMetaService(muxHome));
      const ctx: MemoryScopeContext = {
        runtime,
        checkoutCwd,
        workspaceId: "ws-ssh",
        projectPath: "/projects/memory-ssh",
      };

      // create
      const created = await service.create(
        ctx,
        "/memories/project/conventions.md",
        "Use feature flags for risky changes.",
        "agent"
      );
      expect(created.success).toBe(true);

      // file physically exists on the remote host under <checkout>/.mux/memory
      const remoteCat = await execBuffered(
        runtime,
        `cat ${checkoutCwd}/.mux/memory/conventions.md`,
        {
          cwd: sshConfig.workdir,
          timeout: 30,
        }
      );
      expect(remoteCat.exitCode).toBe(0);
      expect(remoteCat.stdout).toContain("feature flags");

      // view file
      const viewed = await service.view(ctx, "/memories/project/conventions.md");
      expect(viewed.success).toBe(true);
      if (viewed.success) {
        expect(viewed.output).toContain("feature flags");
      }

      // view directory listing
      const listed = await service.view(ctx, "/memories/project");
      expect(listed.success).toBe(true);
      if (listed.success) {
        expect(listed.output).toContain("conventions.md");
      }

      // strReplace round-trip
      const edited = await service.strReplace(
        ctx,
        "/memories/project/conventions.md",
        "risky changes",
        "experimental changes",
        "agent"
      );
      expect(edited.success).toBe(true);
      const remoteCat2 = await execBuffered(
        runtime,
        `cat ${checkoutCwd}/.mux/memory/conventions.md`,
        {
          cwd: sshConfig.workdir,
          timeout: 30,
        }
      );
      expect(remoteCat2.stdout).toContain("experimental changes");

      // create on existing file errors (locked decision)
      const dup = await service.create(ctx, "/memories/project/conventions.md", "x", "agent");
      expect(dup.success).toBe(false);
    } finally {
      await fsPromises.rm(muxHome, { recursive: true, force: true });
    }
  }, 120000);
});
