import { describe, expect, test } from "bun:test";

import { NotificationEngine } from "./NotificationEngine";

describe("NotificationEngine", () => {
  test("dedupes by notification content", async () => {
    const engine = new NotificationEngine([
      {
        // eslint-disable-next-line @typescript-eslint/require-await
        poll: async () => [{ source: "s1", content: "<notification>hi</notification>" }],
      },
    ]);

    const first = await engine.pollAfterToolCall({ toolName: "bash", toolSucceeded: true, now: 0 });
    expect(first).toEqual(["<notification>hi</notification>"]);

    const second = await engine.pollAfterToolCall({
      toolName: "bash",
      toolSucceeded: true,
      now: 1,
    });
    expect(second).toEqual([]);
  });

  test("aggregates across sources", async () => {
    const engine = new NotificationEngine([
      {
        // eslint-disable-next-line @typescript-eslint/require-await
        poll: async () => [{ source: "s1", content: "<notification>a</notification>" }],
      },
      {
        // eslint-disable-next-line @typescript-eslint/require-await
        poll: async () => [{ source: "s2", content: "<notification>b</notification>" }],
      },
    ]);

    const result = await engine.pollAfterToolCall({
      toolName: "bash",
      toolSucceeded: true,
      now: 0,
    });
    expect(result).toEqual(["<notification>a</notification>", "<notification>b</notification>"]);
  });
});
