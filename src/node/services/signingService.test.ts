import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { SigningService } from "./signingService";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";

describe("SigningService", () => {
  // Create isolated temp directory for each test run
  const testDir = join(
    tmpdir(),
    `signing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const ed25519KeyPath = join(testDir, "id_ed25519");
  const ecdsaKeyPath = join(testDir, "id_ecdsa");

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    // Generate keys using ssh-keygen (same format users would have)
    execSync(`ssh-keygen -t ed25519 -f "${ed25519KeyPath}" -N "" -q`);
    execSync(`ssh-keygen -t ecdsa -b 256 -f "${ecdsaKeyPath}" -N "" -q`);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("with Ed25519 key", () => {
    it("should load key and return capabilities", async () => {
      const service = new SigningService([ed25519KeyPath]);
      const capabilities = await service.getCapabilities();

      expect(capabilities.publicKey).toBeDefined();
      expect(capabilities.publicKey).toStartWith("ssh-ed25519 ");
    });

    it("should return sign credentials with valid private key bytes", async () => {
      const service = new SigningService([ed25519KeyPath]);
      const creds = await service.getSignCredentials();

      expect(creds.privateKeyBase64).toBeDefined();
      expect(creds.privateKeyBase64.length).toBeGreaterThan(0);
      expect(creds.publicKey).toStartWith("ssh-ed25519 ");
      // Ed25519 private key seed is 32 bytes
      const keyBytes = Buffer.from(creds.privateKeyBase64, "base64");
      expect(keyBytes.length).toBe(32);
    });

    it("should return consistent public key across multiple calls", async () => {
      const service = new SigningService([ed25519KeyPath]);
      const caps1 = await service.getCapabilities();
      const caps2 = await service.getCapabilities();
      const creds = await service.getSignCredentials();

      expect(caps1.publicKey).toBe(caps2.publicKey);
      expect(caps1.publicKey).toBe(creds.publicKey);
    });
  });

  describe("with ECDSA key", () => {
    it("should load key and return capabilities", async () => {
      const service = new SigningService([ecdsaKeyPath]);
      const capabilities = await service.getCapabilities();

      expect(capabilities.publicKey).toBeDefined();
      expect(capabilities.publicKey).toStartWith("ecdsa-sha2-nistp256 ");
    });

    it("should return sign credentials with valid private key bytes", async () => {
      const service = new SigningService([ecdsaKeyPath]);
      const creds = await service.getSignCredentials();

      expect(creds.privateKeyBase64).toBeDefined();
      expect(creds.privateKeyBase64.length).toBeGreaterThan(0);
      expect(creds.publicKey).toStartWith("ecdsa-sha2-nistp256 ");
      // ECDSA P-256 private scalar is 32 bytes
      const keyBytes = Buffer.from(creds.privateKeyBase64, "base64");
      expect(keyBytes.length).toBe(32);
    });
  });

  describe("with no key", () => {
    it("should return null publicKey when no key exists", async () => {
      const service = new SigningService(["/nonexistent/path/key"]);
      const caps = await service.getCapabilities();

      expect(caps.publicKey).toBeNull();
      expect(caps.error).toBeDefined();
    });

    it("should throw when getting credentials without a key", async () => {
      const service = new SigningService(["/nonexistent/path/key"]);

      let threw = false;
      try {
        await service.getSignCredentials();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  describe("key path priority", () => {
    it("should use first available key in path order", async () => {
      // ECDSA first, Ed25519 second - should pick ECDSA
      const service = new SigningService([ecdsaKeyPath, ed25519KeyPath]);
      const caps = await service.getCapabilities();

      expect(caps.publicKey).toStartWith("ecdsa-sha2-nistp256 ");
    });

    it("should skip missing paths and use next available", async () => {
      // Nonexistent first, Ed25519 second - should pick Ed25519
      const service = new SigningService(["/nonexistent/key", ed25519KeyPath]);
      const caps = await service.getCapabilities();

      expect(caps.publicKey).toStartWith("ssh-ed25519 ");
    });
  });
});
