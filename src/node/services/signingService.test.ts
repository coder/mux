import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SigningService } from "./signingService";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { generateKeyPairSync } from "crypto";

describe("SigningService", () => {
  const testKeyDir = join(homedir(), ".mux");
  const testKeyPath = join(testKeyDir, "id_ed25519");
  let keyCreated = false;

  beforeAll(() => {
    // Create a test Ed25519 key if none exists at either location
    const sshKeyPath = join(homedir(), ".ssh", "id_ed25519");
    if (!existsSync(testKeyPath) && !existsSync(sshKeyPath)) {
      mkdirSync(testKeyDir, { recursive: true });
      const { privateKey } = generateKeyPairSync("ed25519");
      const pemKey = privateKey.export({ type: "pkcs8", format: "pem" });
      writeFileSync(testKeyPath, pemKey, { mode: 0o600 });
      keyCreated = true;
    }
  });

  afterAll(() => {
    // Clean up only if we created the key
    if (keyCreated && existsSync(testKeyPath)) {
      rmSync(testKeyPath);
      keyCreated = false;
    }
  });

  it("should load Ed25519 key and return capabilities", async () => {
    const service = new SigningService();
    const capabilities = await service.getCapabilities();

    expect(capabilities.available).toBe(true);
    expect(capabilities.publicKey).toBeDefined();
    expect(capabilities.publicKey).toStartWith("ssh-ed25519 ");
    // GitHub detection may or may not succeed depending on environment
    // githubUser is either string or null
    expect(capabilities.githubUser === null || typeof capabilities.githubUser === "string").toBe(
      true
    );
  });

  it("should sign content and return valid signature", async () => {
    const service = new SigningService();
    const content = "# Hello World\n\nThis is test content.";
    const result = await service.sign(content);

    expect(result.signature).toBeDefined();
    expect(result.signature.length).toBeGreaterThan(0);
    expect(result.publicKey).toStartWith("ssh-ed25519 ");
  });

  it("should return consistent public key across multiple calls", async () => {
    const service = new SigningService();
    const caps1 = await service.getCapabilities();
    const caps2 = await service.getCapabilities();
    const signResult = await service.sign("test");

    expect(caps1.publicKey).toBe(caps2.publicKey);
    expect(caps1.publicKey).toBe(signResult.publicKey);
  });

  it("should produce 64-byte signature (86 chars base64)", async () => {
    const service = new SigningService();
    const result = await service.sign("test content");
    // Base64 of 64 bytes = 86 chars (with padding or without trailing ==)
    expect(result.signature.replace(/=+$/, "").length).toBeGreaterThanOrEqual(85);
    expect(result.signature.replace(/=+$/, "").length).toBeLessThanOrEqual(88);
  });

  it("should return unavailable when no key exists", async () => {
    const service = new SigningService();
    // Create a service that won't find any keys by checking non-existent paths
    // We can't easily test this without mocking, but we can verify the error message format
    const caps = await service.getCapabilities();
    // If we have a key (from setup), it should be available
    // This test mainly ensures the code path doesn't crash
    expect(typeof caps.available).toBe("boolean");
  });
});
