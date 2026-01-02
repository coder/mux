import { describe, it, expect, beforeEach } from "bun:test";
import { SigningService } from "./signingService";

describe("SigningService", () => {
  let service: SigningService;

  beforeEach(() => {
    service = new SigningService();
  });

  it("should generate a valid Ed25519 keypair and return capabilities", async () => {
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
    const content = "# Hello World\n\nThis is test content.";
    const result = await service.sign(content);

    expect(result.signature).toBeDefined();
    expect(result.signature.length).toBeGreaterThan(0);
    expect(result.publicKey).toStartWith("ssh-ed25519 ");
  });

  it("should return consistent public key across multiple calls", async () => {
    const caps1 = await service.getCapabilities();
    const caps2 = await service.getCapabilities();
    const signResult = await service.sign("test");

    expect(caps1.publicKey).toBe(caps2.publicKey);
    expect(caps1.publicKey).toBe(signResult.publicKey);
  });

  it("should produce 64-byte signature (86 chars base64)", async () => {
    const result = await service.sign("test content");
    // Base64 of 64 bytes = 86 chars (with padding or without trailing ==)
    expect(result.signature.replace(/=+$/, "").length).toBeGreaterThanOrEqual(85);
    expect(result.signature.replace(/=+$/, "").length).toBeLessThanOrEqual(88);
  });
});
