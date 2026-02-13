import { describe, it, expect, beforeEach, afterEach, vi, mock } from "bun:test";

import type { HostKeyVerificationRequest } from "@/common/orpc/schemas/ssh";

const TEST_TIMEOUT_MS = 20;

mock.module("@/common/constants/ssh", () => ({
  HOST_KEY_APPROVAL_TIMEOUT_MS: TEST_TIMEOUT_MS,
}));

const { HostKeyVerificationService } = await import("./hostKeyVerificationService");

const REQUEST_PARAMS: Omit<HostKeyVerificationRequest, "requestId"> = {
  host: "example.com",
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:abcdef",
  prompt: "Trust host key?",
};

function waitForTimeout(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, TEST_TIMEOUT_MS * 3);
  });
}

describe("HostKeyVerificationService", () => {
  let service: InstanceType<typeof HostKeyVerificationService>;
  let requests: HostKeyVerificationRequest[];

  beforeEach(() => {
    service = new HostKeyVerificationService();
    requests = [];
    service.on("request", (req: HostKeyVerificationRequest) => {
      requests.push(req);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves on explicit respond", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(1);
    service.respond(requests[0].requestId, true);

    await expect(verification).resolves.toBe(true);
  });

  it("resolves false on timeout", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);

    await waitForTimeout();

    await expect(verification).resolves.toBe(false);
  });

  it("deduped waiters all resolve on respond", async () => {
    const verification1 = service.requestVerification(REQUEST_PARAMS);
    const verification2 = service.requestVerification(REQUEST_PARAMS);
    const verification3 = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(1);
    service.respond(requests[0].requestId, true);

    await expect(Promise.all([verification1, verification2, verification3])).resolves.toEqual([
      true,
      true,
      true,
    ]);
  });

  it("deduped waiters all resolve false on timeout", async () => {
    const verification1 = service.requestVerification(REQUEST_PARAMS);
    const verification2 = service.requestVerification(REQUEST_PARAMS);
    const verification3 = service.requestVerification(REQUEST_PARAMS);

    await waitForTimeout();

    await expect(Promise.all([verification1, verification2, verification3])).resolves.toEqual([
      false,
      false,
      false,
    ]);
  });

  it("late respond after timeout is a no-op", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    await waitForTimeout();
    await expect(verification).resolves.toBe(false);

    expect(() => {
      service.respond(requestId, true);
    }).not.toThrow();
  });

  it("host can be re-requested after timeout cleanup", async () => {
    const firstVerification = service.requestVerification(REQUEST_PARAMS);

    await waitForTimeout();
    await expect(firstVerification).resolves.toBe(false);

    const secondVerification = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(2);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);

    service.respond(requests[1].requestId, true);

    await expect(secondVerification).resolves.toBe(true);
  });

  it("emits request event only for first caller", async () => {
    const verification1 = service.requestVerification(REQUEST_PARAMS);
    const verification2 = service.requestVerification(REQUEST_PARAMS);
    const verification3 = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(1);

    service.respond(requests[0].requestId, true);

    await expect(Promise.all([verification1, verification2, verification3])).resolves.toEqual([
      true,
      true,
      true,
    ]);
  });
});
