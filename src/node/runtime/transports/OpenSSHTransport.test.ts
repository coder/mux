import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "child_process";

import { SshPromptService } from "@/node/services/sshPromptService";
import {
  setSshPromptService,
  setOpenSSHHostKeyPolicyMode,
  sshConnectionPool,
} from "../sshConnectionPool";
import { OpenSSHTransport } from "./OpenSSHTransport";

function createMockChildProcess(): ReturnType<typeof childProcess.spawn> {
  return {
    on: mock(() => undefined),
    pid: 12345,
  } as unknown as ReturnType<typeof childProcess.spawn>;
}

describe("OpenSSHTransport.spawnRemoteProcess", () => {
  let spawnSpy: ReturnType<typeof spyOn<typeof childProcess, "spawn">>;
  let acquireConnectionSpy: ReturnType<typeof spyOn<typeof sshConnectionPool, "acquireConnection">>;
  let releaseInteractiveResponder: (() => void) | undefined;

  beforeEach(() => {
    spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() =>
      createMockChildProcess()) as unknown as typeof childProcess.spawn);
    acquireConnectionSpy = spyOn(sshConnectionPool, "acquireConnection").mockResolvedValue(
      undefined
    );
  });

  afterEach(() => {
    releaseInteractiveResponder?.();
    releaseInteractiveResponder = undefined;
    // Reset to a configured service without responders so state does not leak across tests.
    setSshPromptService(new SshPromptService());
    setOpenSSHHostKeyPolicyMode("headless-fallback");

    spawnSpy.mockRestore();
    acquireConnectionSpy.mockRestore();
  });

  function setHostKeyVerificationCapability(configured: boolean): SshPromptService | undefined {
    releaseInteractiveResponder?.();
    releaseInteractiveResponder = undefined;

    if (!configured) {
      setSshPromptService(undefined);
      return undefined;
    }

    const service = new SshPromptService();
    setSshPromptService(service);
    return service;
  }

  async function runSpawnRemoteProcess(): Promise<string[]> {
    const transport = new OpenSSHTransport({ host: "remote.example.com" });
    await transport.spawnRemoteProcess("echo ok", {});

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [command, args] = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
    expect(command).toBe("ssh");
    return args;
  }

  test("explicit headless (no service) includes host-key fallback options and BatchMode=yes", async () => {
    setHostKeyVerificationCapability(false);
    setOpenSSHHostKeyPolicyMode("headless-fallback");

    const args = await runSpawnRemoteProcess();

    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=no");
    expect(args).toContain("UserKnownHostsFile=/dev/null");
    expect(args.indexOf("StrictHostKeyChecking=no")).toBeGreaterThan(args.indexOf("BatchMode=yes"));
    expect(args.indexOf("UserKnownHostsFile=/dev/null")).toBeGreaterThan(
      args.indexOf("StrictHostKeyChecking=no")
    );
  });

  test("service configured keeps BatchMode=yes but excludes host-key fallback options", async () => {
    const service = setHostKeyVerificationCapability(true);
    releaseInteractiveResponder = service?.registerInteractiveResponder();
    setOpenSSHHostKeyPolicyMode("strict");

    const args = await runSpawnRemoteProcess();

    expect(args).toContain("BatchMode=yes");
    expect(args).not.toContain("StrictHostKeyChecking=no");
    expect(args).not.toContain("UserKnownHostsFile=/dev/null");
  });

  test("service configured without active responder still excludes host-key fallback options", async () => {
    setHostKeyVerificationCapability(true);
    setOpenSSHHostKeyPolicyMode("strict");

    const args = await runSpawnRemoteProcess();

    expect(args).toContain("BatchMode=yes");
    expect(args).not.toContain("StrictHostKeyChecking=no");
    expect(args).not.toContain("UserKnownHostsFile=/dev/null");
  });
});
