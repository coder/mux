import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { parsePublicKey, verifySignature, type SignatureEnvelope } from "@coder/mux-md-client";
import { execSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SigningService } from "./signingService";

async function expectValidSignature(content: string, envelope: SignatureEnvelope): Promise<void> {
  const parsed = parsePublicKey(envelope.publicKey);
  const signatureBytes = Buffer.from(envelope.sig, "base64");
  const messageBytes = new TextEncoder().encode(content);

  const isValid = await verifySignature(parsed, messageBytes, new Uint8Array(signatureBytes));
  expect(isValid).toBe(true);
}

function startSshAgent(): { sshAuthSock: string; sshAgentPid: string } {
  const output = execSync("ssh-agent -s").toString("utf-8");

  const sockMatch = /SSH_AUTH_SOCK=([^;]+);/m.exec(output);
  const pidMatch = /SSH_AGENT_PID=([0-9]+);/m.exec(output);
  if (!sockMatch || !pidMatch) {
    throw new Error(`Failed to parse ssh-agent output: ${output}`);
  }

  return { sshAuthSock: sockMatch[1], sshAgentPid: pidMatch[1] };
}

/** Run test body with SSH_AUTH_SOCK cleared to ensure disk keys are used */
async function withoutSshAgent<T>(fn: () => Promise<T>): Promise<T> {
  const savedSock = process.env.SSH_AUTH_SOCK;
  const savedPid = process.env.SSH_AGENT_PID;

  delete process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AGENT_PID;

  try {
    return await fn();
  } finally {
    if (savedSock === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = savedSock;
    }

    if (savedPid === undefined) {
      delete process.env.SSH_AGENT_PID;
    } else {
      process.env.SSH_AGENT_PID = savedPid;
    }
  }
}

describe("SigningService", () => {
  // Create isolated temp directory for each test run
  const testDir = join(
    tmpdir(),
    `signing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  const ed25519KeyPath = join(testDir, "id_ed25519");
  const ecdsaKeyPath = join(testDir, "id_ecdsa");
  const encryptedKeyPath = join(testDir, "id_encrypted");

  const prevEnv = {
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    SSH_AGENT_PID: process.env.SSH_AGENT_PID,
  };

  beforeAll(() => {
    // Ensure these tests are not influenced by a user's existing ssh-agent.
    delete process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AGENT_PID;

    mkdirSync(testDir, { recursive: true });
    // Generate keys using ssh-keygen (same format users would have)
    execSync(`ssh-keygen -t ed25519 -f "${ed25519KeyPath}" -N "" -q`);
    execSync(`ssh-keygen -t ecdsa -b 256 -f "${ecdsaKeyPath}" -N "" -q`);
    execSync(`ssh-keygen -t ed25519 -f "${encryptedKeyPath}" -N "testpassword" -q`);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });

    if (prevEnv.SSH_AUTH_SOCK === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = prevEnv.SSH_AUTH_SOCK;
    }

    if (prevEnv.SSH_AGENT_PID === undefined) {
      delete process.env.SSH_AGENT_PID;
    } else {
      process.env.SSH_AGENT_PID = prevEnv.SSH_AGENT_PID;
    }
  });

  describe("with Ed25519 key", () => {
    it("should load key and return capabilities", () =>
      withoutSshAgent(async () => {
        const service = new SigningService([ed25519KeyPath]);
        const capabilities = await service.getCapabilities();

        expect(capabilities.publicKey).toBeDefined();
        expect(capabilities.publicKey).toStartWith("ssh-ed25519 ");
      }));

    it("should sign messages", () =>
      withoutSshAgent(async () => {
        const service = new SigningService([ed25519KeyPath]);
        const content = "hello world";
        const envelope = await service.signMessage(content);

        expect(envelope.publicKey).toStartWith("ssh-ed25519 ");
        await expectValidSignature(content, envelope);
      }));

    it("should return consistent public key across multiple calls", () =>
      withoutSshAgent(async () => {
        const service = new SigningService([ed25519KeyPath]);
        const caps1 = await service.getCapabilities();
        const caps2 = await service.getCapabilities();
        const envelope = await service.signMessage("consistency");

        expect(caps1.publicKey).toBe(caps2.publicKey);
        expect(caps1.publicKey).toBe(envelope.publicKey);
      }));
  });

  describe("with ECDSA key", () => {
    it("should load key and return capabilities", () =>
      withoutSshAgent(async () => {
        const service = new SigningService([ecdsaKeyPath]);
        const capabilities = await service.getCapabilities();

        expect(capabilities.publicKey).toBeDefined();
        expect(capabilities.publicKey).toStartWith("ecdsa-sha2-nistp256 ");
      }));

    it("should sign messages", () =>
      withoutSshAgent(async () => {
        const content = "hello ecdsa";
        let envelope: SignatureEnvelope | null = null;

        // Some randomly-generated ECDSA keys trigger a downstream mux-md-client
        // scalar-length parsing bug (31-byte scalar). Regenerate and retry so this
        // test stays deterministic while still validating ECDSA signing behavior.
        for (let attempt = 0; attempt < 3; attempt++) {
          const service = new SigningService([ecdsaKeyPath]);
          try {
            envelope = await service.signMessage(content);
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes("Field.fromBytes: expected 32 bytes, got 31")) {
              throw error;
            }

            rmSync(ecdsaKeyPath, { force: true });
            rmSync(`${ecdsaKeyPath}.pub`, { force: true });
            execSync(`ssh-keygen -t ecdsa -b 256 -f "${ecdsaKeyPath}" -N "" -q`);
          }
        }

        if (!envelope) {
          throw new Error("Failed to generate a valid ECDSA key for signing test");
        }

        expect(envelope.publicKey).toStartWith("ecdsa-sha2-nistp256 ");
        await expectValidSignature(content, envelope);
      }));
  });

  describe("with no key", () => {
    it("should return null publicKey when no key exists", () =>
      withoutSshAgent(async () => {
        const service = new SigningService(["/nonexistent/path/key"]);
        const caps = await service.getCapabilities();

        expect(caps.publicKey).toBeNull();
        expect(caps.error).toBeDefined();
        expect(caps.error?.hasEncryptedKey).toBe(false);
      }));

    it("should throw when signing without a key", () =>
      withoutSshAgent(async () => {
        const service = new SigningService(["/nonexistent/path/key"]);

        let threw = false;
        try {
          await service.signMessage("no key");
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      }));
  });

  describe("key path priority", () => {
    it("should use first available key in path order", () =>
      withoutSshAgent(async () => {
        // ECDSA first, Ed25519 second - should pick ECDSA
        const service = new SigningService([ecdsaKeyPath, ed25519KeyPath]);
        const caps = await service.getCapabilities();

        expect(caps.publicKey).toStartWith("ecdsa-sha2-nistp256 ");
      }));

    it("should skip missing paths and use next available", () =>
      withoutSshAgent(async () => {
        // Nonexistent first, Ed25519 second - should pick Ed25519
        const service = new SigningService(["/nonexistent/key", ed25519KeyPath]);
        const caps = await service.getCapabilities();

        expect(caps.publicKey).toStartWith("ssh-ed25519 ");
      }));
  });

  describe("with encrypted key", () => {
    it("should detect encrypted key and return hasEncryptedKey=true", () =>
      withoutSshAgent(async () => {
        const service = new SigningService([encryptedKeyPath]);
        const caps = await service.getCapabilities();

        expect(caps.publicKey).toBeNull();
        expect(caps.error?.hasEncryptedKey).toBe(true);
        expect(caps.error?.message).toContain("passphrase");
      }));

    it("should skip encrypted key and use unencrypted fallback", () =>
      withoutSshAgent(async () => {
        // Encrypted first, unencrypted second - should skip encrypted and use unencrypted
        const service = new SigningService([encryptedKeyPath, ed25519KeyPath]);
        const caps = await service.getCapabilities();

        expect(caps.publicKey).toStartWith("ssh-ed25519 ");
        // Key loaded successfully - error may exist for identity detection (gh not installed)
        // but should NOT have hasEncryptedKey flag since we found a usable key
        if (caps.error) {
          expect(caps.error.hasEncryptedKey).toBe(false);
        }
      }));

    it("should reset hasEncryptedKey on cache clear", () =>
      withoutSshAgent(async () => {
        const service = new SigningService([encryptedKeyPath]);
        const caps1 = await service.getCapabilities();
        expect(caps1.error?.hasEncryptedKey).toBe(true);

        service.clearIdentityCache();
        // After clearing, a fresh load should still detect the encrypted key
        const caps2 = await service.getCapabilities();
        expect(caps2.error?.hasEncryptedKey).toBe(true);
      }));
  });

  describe("with ssh-agent", () => {
    let sshAuthSock: string | null = null;
    let sshAgentPid: string | null = null;

    beforeAll(() => {
      const agent = startSshAgent();
      sshAuthSock = agent.sshAuthSock;
      sshAgentPid = agent.sshAgentPid;

      process.env.SSH_AUTH_SOCK = sshAuthSock;
      process.env.SSH_AGENT_PID = sshAgentPid;

      execSync(`ssh-add -q "${ed25519KeyPath}"`, { env: process.env });
    });

    afterAll(() => {
      if (sshAuthSock && sshAgentPid) {
        try {
          execSync("ssh-agent -k", {
            env: {
              ...process.env,
              SSH_AUTH_SOCK: sshAuthSock,
              SSH_AGENT_PID: sshAgentPid,
            },
          });
        } catch {
          // Best-effort cleanup.
        }
      }

      delete process.env.SSH_AUTH_SOCK;
      delete process.env.SSH_AGENT_PID;
    });

    it("should prefer agent key over disk fallback", async () => {
      // Nonexistent explicit path forces the service to choose between agent and fallback.
      // The agent provides Ed25519; fallback provides ECDSA.
      const service = new SigningService(["/nonexistent/key", ecdsaKeyPath]);
      const caps = await service.getCapabilities();

      expect(caps.publicKey).toStartWith("ssh-ed25519 ");

      const content = "agent signing";
      const envelope = await service.signMessage(content);
      expect(envelope.publicKey).toStartWith("ssh-ed25519 ");
      await expectValidSignature(content, envelope);
    });

    it("should use agent key when only encrypted disk key is present", async () => {
      const service = new SigningService([encryptedKeyPath]);
      const caps = await service.getCapabilities();

      expect(caps.publicKey).toStartWith("ssh-ed25519 ");
      if (caps.error) {
        expect(caps.error.hasEncryptedKey).toBe(false);
      }
    });
  });
});
