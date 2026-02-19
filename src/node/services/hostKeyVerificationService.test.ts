import { describe, it, expect, beforeEach } from "bun:test";

import { HostKeyVerificationService } from "./hostKeyVerificationService";
import type { HostKeyVerificationRequest } from "@/common/orpc/schemas/ssh";

/** Short timeout for tests — avoids waiting the real 60s. */
const TEST_TIMEOUT_MS = 20;

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
  let service: HostKeyVerificationService;
  let requests: HostKeyVerificationRequest[];
  let releaseResponder: () => void;

  beforeEach(() => {
    service = new HostKeyVerificationService(TEST_TIMEOUT_MS);
    requests = [];
    service.on("request", (req: HostKeyVerificationRequest) => {
      requests.push(req);
    });
    releaseResponder = service.registerInteractiveResponder();
  });

  it("resolves on explicit respond", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(1);
    service.respond(requests[0].requestId, true);

    const result = await verification;
    expect(result).toBe(true);
  });

  it("resolves false on timeout", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);

    await waitForTimeout();

    const result = await verification;
    expect(result).toBe(false);
  });

  it("deduped waiters all resolve on respond", async () => {
    const verification1 = service.requestVerification(REQUEST_PARAMS);
    const verification2 = service.requestVerification(REQUEST_PARAMS);
    const verification3 = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(1);
    service.respond(requests[0].requestId, true);

    const results = await Promise.all([verification1, verification2, verification3]);
    expect(results).toEqual([true, true, true]);
  });

  it("deduped waiters all resolve false on timeout", async () => {
    const verification1 = service.requestVerification(REQUEST_PARAMS);
    const verification2 = service.requestVerification(REQUEST_PARAMS);
    const verification3 = service.requestVerification(REQUEST_PARAMS);

    await waitForTimeout();

    const results = await Promise.all([verification1, verification2, verification3]);
    expect(results).toEqual([false, false, false]);
  });

  it("late respond after timeout is a no-op", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    await waitForTimeout();
    const result = await verification;
    expect(result).toBe(false);

    expect(() => {
      service.respond(requestId, true);
    }).not.toThrow();
  });

  it("host can be re-requested after timeout cleanup", async () => {
    const firstVerification = service.requestVerification(REQUEST_PARAMS);

    await waitForTimeout();
    const firstResult = await firstVerification;
    expect(firstResult).toBe(false);

    const secondVerification = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(2);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);

    service.respond(requests[1].requestId, true);

    const secondResult = await secondVerification;
    expect(secondResult).toBe(true);
  });

  it("emits request event only for first caller", async () => {
    const verification1 = service.requestVerification(REQUEST_PARAMS);
    const verification2 = service.requestVerification(REQUEST_PARAMS);
    const verification3 = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(1);

    service.respond(requests[0].requestId, true);

    const results = await Promise.all([verification1, verification2, verification3]);
    expect(results).toEqual([true, true, true]);
  });

  it("rejects immediately with no responders", async () => {
    releaseResponder();

    const result = await service.requestVerification(REQUEST_PARAMS);

    expect(result).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("emits request when responder is registered", async () => {
    releaseResponder();
    const release = service.registerInteractiveResponder();

    const verification = service.requestVerification(REQUEST_PARAMS);

    expect(requests).toHaveLength(1);
    service.respond(requests[0].requestId, true);

    const result = await verification;
    expect(result).toBe(true);

    release();
  });

  it("rejects immediately after responder released", async () => {
    releaseResponder();

    const result = await service.requestVerification(REQUEST_PARAMS);

    expect(result).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("keeps pending verification alive when last responder disconnects", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);
    expect(requests).toHaveLength(1);

    // Simulate renderer disconnect — last responder released while prompt pending.
    releaseResponder();

    // Re-register before responding (simulates reconnect).
    const release2 = service.registerInteractiveResponder();
    service.respond(requests[0].requestId, true);

    // Pending request survived the responder gap and was accepted.
    const result = await verification;
    expect(result).toBe(true);

    release2();
  });

  it("joins an existing deduped request while responders are temporarily disconnected", async () => {
    const v1 = service.requestVerification({ ...REQUEST_PARAMS, dedupeKey: "example.com:22" });
    expect(requests).toHaveLength(1);

    releaseResponder();
    const v2 = service.requestVerification({ ...REQUEST_PARAMS, dedupeKey: "example.com:22" });

    expect(requests).toHaveLength(1);

    const release2 = service.registerInteractiveResponder();
    service.respond(requests[0].requestId, true);

    const results = await Promise.all([v1, v2]);
    expect(results).toEqual([true, true]);
    release2();
  });

  it("times out pending verification even after all responders disconnect", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);
    expect(requests).toHaveLength(1);

    releaseResponder();

    // No responder to approve — timeout should still fire and reject.
    await waitForTimeout();
    const result = await verification;
    expect(result).toBe(false);
  });
  it("double-release is safe", () => {
    releaseResponder();

    const release = service.registerInteractiveResponder();

    expect(() => {
      release();
      release();
    }).not.toThrow();
  });

  it("does not coalesce when dedupeKey differs", async () => {
    const v1 = service.requestVerification({ ...REQUEST_PARAMS, dedupeKey: "example.com:22" });
    const v2 = service.requestVerification({ ...REQUEST_PARAMS, dedupeKey: "example.com:2222" });

    expect(requests).toHaveLength(2);

    service.respond(requests[0].requestId, true);
    service.respond(requests[1].requestId, false);

    expect(await v1).toBe(true);
    expect(await v2).toBe(false);
  });

  it("coalesces when dedupeKey matches", async () => {
    const v1 = service.requestVerification({ ...REQUEST_PARAMS, dedupeKey: "example.com:22" });
    const v2 = service.requestVerification({ ...REQUEST_PARAMS, dedupeKey: "example.com:22" });

    expect(requests).toHaveLength(1);

    service.respond(requests[0].requestId, true);

    const results = await Promise.all([v1, v2]);
    expect(results).toEqual([true, true]);
  });

  it("replays pending requests to late subscribers", async () => {
    // Request emitted BEFORE subscriber connects
    const verification = service.requestVerification(REQUEST_PARAMS);
    expect(requests).toHaveLength(1);
    const requestId = requests[0].requestId;

    // Late subscriber should see the pending request via snapshot
    const lateRequests: HostKeyVerificationRequest[] = [];
    const { snapshot, unsubscribe } = service.subscribeRequests((req) => {
      lateRequests.push(req);
    });

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].requestId).toBe(requestId);
    expect(snapshot[0].host).toBe("example.com");

    unsubscribe();
    service.respond(requestId, true);
    await verification;
  });

  it("does not replay resolved requests", async () => {
    const verification = service.requestVerification(REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    service.respond(requestId, true);
    await verification;

    // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op listener; we only care about the snapshot
    const { snapshot, unsubscribe } = service.subscribeRequests(() => {});
    expect(snapshot).toHaveLength(0);
    unsubscribe();
  });

  it("emits removed event on timeout", async () => {
    const removedIds: string[] = [];
    service.on("removed", (id: string) => removedIds.push(id));

    const verification = service.requestVerification(REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    await waitForTimeout();
    await verification;

    expect(removedIds).toEqual([requestId]);
  });

  it("emits removed event on explicit respond", async () => {
    const removedIds: string[] = [];
    service.on("removed", (id: string) => removedIds.push(id));

    const verification = service.requestVerification(REQUEST_PARAMS);
    const requestId = requests[0].requestId;

    service.respond(requestId, true);
    await verification;

    expect(removedIds).toEqual([requestId]);
  });
});
