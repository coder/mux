import {
  parseBackoffSecondsFromErrorMessage,
  retrySSHForInit,
  isRetryableSSHTransportErrorMessage,
} from "./sshInitRetry";

describe("sshInitRetry", () => {
  test("parseBackoffSecondsFromErrorMessage extracts seconds", () => {
    expect(parseBackoffSecondsFromErrorMessage("SSH connection to x is in backoff for 5s.")).toBe(
      5
    );
    expect(parseBackoffSecondsFromErrorMessage("in backoff for 60s")).toBe(60);
    expect(parseBackoffSecondsFromErrorMessage("no backoff here")).toBeNull();
  });

  test("isRetryableSSHTransportErrorMessage is conservative", () => {
    expect(isRetryableSSHTransportErrorMessage("ssh: Could not resolve hostname ovh-1")).toBe(true);
    expect(isRetryableSSHTransportErrorMessage("SSH probe timed out")).toBe(true);
    expect(isRetryableSSHTransportErrorMessage("fatal: ambiguous argument 'main'")).toBe(false);
  });

  test("retrySSHForInit waits through pool backoff and retries", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];

    const result = await retrySSHForInit(
      () => {
        calls++;
        if (calls === 1) {
          return Promise.reject(
            new Error(
              "SSH connection to ovh-1 is in backoff for 5s. Last error: SSH connection failed (exit code 255)"
            )
          );
        }
        return Promise.resolve("ok");
      },
      {
        maxAttempts: 3,
        sleep: (ms: number) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      }
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([5000]);
  });

  test("retrySSHForInit retries on direct ssh transport errors", async () => {
    let calls = 0;
    const sleepCalls: number[] = [];

    const result = await retrySSHForInit(
      () => {
        calls++;
        if (calls === 1) {
          return Promise.reject(
            new Error("ssh: Could not resolve hostname ovh-1: Name or service not known")
          );
        }
        return Promise.resolve("ok");
      },
      {
        maxAttempts: 3,
        sleep: (ms: number) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      }
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(sleepCalls).toEqual([1000]);
  });

  test("retrySSHForInit respects abortSignal", async () => {
    const controller = new AbortController();
    let calls = 0;

    await expect(
      retrySSHForInit(
        () => {
          calls++;
          return Promise.reject(
            new Error("SSH connection to ovh-1 is in backoff for 1s. Last error: ...")
          );
        },
        {
          maxAttempts: 3,
          abortSignal: controller.signal,
          sleep: () => {
            controller.abort();
            return Promise.reject(new Error("Operation aborted"));
          },
        }
      )
    ).rejects.toThrow(/aborted/i);

    expect(calls).toBe(1);
  });
});
