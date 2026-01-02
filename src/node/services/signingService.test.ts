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

    it("should sign content and return valid signature", async () => {
      const service = new SigningService([ed25519KeyPath]);
      const content = "# Hello World\n\nThis is test content.";
      const result = await service.sign(content);

      expect(result.signature).toBeDefined();
      expect(result.signature.length).toBeGreaterThan(0);
      expect(result.publicKey).toStartWith("ssh-ed25519 ");
      // Ed25519 signatures are exactly 64 bytes
      const sigBytes = Buffer.from(result.signature, "base64");
      expect(sigBytes.length).toBe(64);
    });

    it("should return consistent public key across multiple calls", async () => {
      const service = new SigningService([ed25519KeyPath]);
      const caps1 = await service.getCapabilities();
      const caps2 = await service.getCapabilities();
      const signResult = await service.sign("test");

      expect(caps1.publicKey).toBe(caps2.publicKey);
      expect(caps1.publicKey).toBe(signResult.publicKey);
    });
  });

  describe("with ECDSA key", () => {
    it("should load key and return capabilities", async () => {
      const service = new SigningService([ecdsaKeyPath]);
      const capabilities = await service.getCapabilities();

      expect(capabilities.publicKey).toBeDefined();
      expect(capabilities.publicKey).toStartWith("ecdsa-sha2-nistp256 ");
    });

    it("should sign content and return valid signature", async () => {
      const service = new SigningService([ecdsaKeyPath]);
      const content = "# Hello World\n\nThis is test content.";
      const result = await service.sign(content);

      expect(result.signature).toBeDefined();
      expect(result.signature.length).toBeGreaterThan(0);
      expect(result.publicKey).toStartWith("ecdsa-sha2-nistp256 ");
      // ECDSA signatures are DER-encoded, typically 70-72 bytes for P-256
      const sigBytes = Buffer.from(result.signature, "base64");
      expect(sigBytes.length).toBeGreaterThanOrEqual(68);
      expect(sigBytes.length).toBeLessThanOrEqual(74);
    });
  });

  describe("with no key", () => {
    it("should return null publicKey when no key exists", async () => {
      const service = new SigningService(["/nonexistent/path/key"]);
      const caps = await service.getCapabilities();

      expect(caps.publicKey).toBeNull();
      expect(caps.error).toBeDefined();
    });

    it("should throw when signing without a key", () => {
      const service = new SigningService(["/nonexistent/path/key"]);

      expect(() => service.sign("test")).toThrow();
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
