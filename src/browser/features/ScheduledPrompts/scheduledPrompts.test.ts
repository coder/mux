import { describe, expect, test } from "bun:test";
import {
  canRunScheduledPromptNow,
  createScheduledPrompt,
  getDueScheduledPrompts,
  getNextScheduledPromptRunAt,
  markScheduledPromptFailed,
  markScheduledPromptSending,
  markScheduledPromptSent,
  normalizeScheduledPrompts,
  removeScheduledPrompt,
  reschedulePromptNow,
  type ScheduledPrompt,
} from "./scheduledPrompts";

const NOW = 1_700_000_000_000;

function scheduledPrompt(overrides: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  return {
    id: "prompt-1",
    content: "Continue when quota resets",
    runAt: NOW + 60_000,
    createdAt: NOW,
    updatedAt: NOW,
    status: "scheduled",
    queueDispatchMode: "tool-end",
    ...overrides,
  };
}

describe("scheduled prompt helpers", () => {
  test("normalizes valid prompts and drops malformed entries", () => {
    const prompts = normalizeScheduledPrompts([
      scheduledPrompt({ id: "later", runAt: NOW + 120_000 }),
      { id: "bad", content: "", runAt: NOW, createdAt: NOW, updatedAt: NOW },
      scheduledPrompt({ id: "earlier", runAt: NOW + 30_000 }),
    ]);

    expect(prompts.map((prompt) => prompt.id)).toEqual(["earlier", "later"]);
  });

  test("keeps in-progress sends in sending state when normalizing", () => {
    const prompts = normalizeScheduledPrompts([
      scheduledPrompt({
        status: "sending",
        updatedAt: NOW - 10 * 60_000,
        error: "stale",
      }),
    ]);

    expect(prompts[0]?.status).toBe("sending");
    expect(prompts[0]?.error).toBeUndefined();
  });

  test("finds due prompts and next scheduled time", () => {
    const prompts = [
      scheduledPrompt({ id: "due", runAt: NOW - 1 }),
      scheduledPrompt({ id: "future", runAt: NOW + 5_000 }),
      scheduledPrompt({ id: "failed", runAt: NOW - 2, status: "failed" }),
    ];

    expect(getDueScheduledPrompts(prompts, NOW).map((prompt) => prompt.id)).toEqual(["due"]);
    expect(getNextScheduledPromptRunAt(prompts)).toBe(NOW - 1);
  });

  test("updates prompt lifecycle state", () => {
    const prompt = createScheduledPrompt(
      {
        content: "  run later  ",
        runAt: NOW + 1_000,
        queueDispatchMode: "turn-end",
      },
      NOW,
      "created"
    );

    expect(prompt).toMatchObject({
      id: "created",
      content: "run later",
      status: "scheduled",
      queueDispatchMode: "turn-end",
    });

    const sending = markScheduledPromptSending([prompt], "created", NOW + 1);
    expect(sending[0]?.status).toBe("sending");

    const failed = markScheduledPromptFailed(sending, "created", "No connection", NOW + 2);
    expect(failed[0]).toMatchObject({ status: "failed", error: "No connection" });

    const retried = reschedulePromptNow(failed, "created", NOW + 3);
    expect(retried[0]).toMatchObject({ status: "scheduled", runAt: NOW + 3 });

    const sent = markScheduledPromptSent(retried, "created", NOW + 4);
    expect(sent[0]).toMatchObject({ status: "sent", sentAt: NOW + 4 });

    expect(removeScheduledPrompt(sent, "created")).toEqual([]);
  });

  test("allows manual recovery for stale sending prompts without auto-rescheduling", () => {
    expect(
      canRunScheduledPromptNow(
        scheduledPrompt({ status: "sending", updatedAt: NOW - 29 * 60_000 }),
        NOW
      )
    ).toBe(false);
    expect(
      canRunScheduledPromptNow(
        scheduledPrompt({ status: "sending", updatedAt: NOW - 31 * 60_000 }),
        NOW
      )
    ).toBe(true);
  });
});
