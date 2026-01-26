import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { CoderService } from "@/node/services/coderService";
import { PolicyService } from "./policyService";

const PREFIX = "mux-policy-service-test-";

class FakeCoderService {
  constructor(private readonly email: string | null) {}

  getSignedInEmail(): Promise<string | null> {
    return Promise.resolve(this.email);
  }
}

describe("PolicyService", () => {
  let tempDir: string;
  let policyPath: string;
  let prevPolicyFileEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), PREFIX));
    policyPath = path.join(tempDir, "policy.js");
    prevPolicyFileEnv = process.env.MUX_POLICY_FILE;
  });

  afterEach(async () => {
    if (prevPolicyFileEnv === undefined) {
      delete process.env.MUX_POLICY_FILE;
    } else {
      process.env.MUX_POLICY_FILE = prevPolicyFileEnv;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test("disabled when MUX_POLICY_FILE is unset", async () => {
    delete process.env.MUX_POLICY_FILE;

    const service = new PolicyService(new FakeCoderService(null) as unknown as CoderService);
    await service.initialize();
    expect(service.getStatus()).toEqual({ state: "disabled" });
    expect(service.getEffectivePolicy()).toBeNull();
    service.dispose();
  });

  test("blocks startup when policy file fails to evaluate", async () => {
    await writeFile(policyPath, "({ policy_format_version: '0.1',", "utf-8");
    process.env.MUX_POLICY_FILE = policyPath;

    const service = new PolicyService(new FakeCoderService(null) as unknown as CoderService);
    await service.initialize();

    const status = service.getStatus();
    expect(status.state).toBe("blocked");
    if (status.state === "blocked") {
      expect(status.reason).toContain("Failed to load policy");
    }

    service.dispose();
  });

  test("blocks startup when minimum_client_version is higher than client", async () => {
    await writeFile(
      policyPath,
      "({ policy_format_version: '0.1', minimum_client_version: '9999.0.0' })",
      "utf-8"
    );
    process.env.MUX_POLICY_FILE = policyPath;

    const service = new PolicyService(new FakeCoderService(null) as unknown as CoderService);
    await service.initialize();

    const status = service.getStatus();
    expect(status.state).toBe("blocked");
    if (status.state === "blocked") {
      expect(status.reason).toContain("minimum_client_version");
    }

    service.dispose();
  });

  test("evaluates JS expressions with user.email context", async () => {
    await writeFile(
      policyPath,
      `({
        policy_format_version: "0.1",
        provider_access: [
          {
            id: "openai",
            model_access: [
              {
                match: user.email === "admin@example.com" ? ["gpt-4"] : ["gpt-3.5"],
              },
            ],
          },
        ],
      })`,
      "utf-8"
    );
    process.env.MUX_POLICY_FILE = policyPath;

    const service = new PolicyService(
      new FakeCoderService("admin@example.com") as unknown as CoderService
    );
    await service.initialize();

    expect(service.isEnforced()).toBe(true);
    expect(service.isProviderAllowed("openai")).toBe(true);
    expect(service.isModelAllowed("openai", "gpt-4")).toBe(true);
    expect(service.isModelAllowed("openai", "gpt-3.5")).toBe(false);

    service.dispose();
  });
});
