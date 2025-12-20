import { describe, expect, test, mock } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { cancelCompaction } from "./handler";

describe("cancelCompaction", () => {
  test("interrupts without restore-to-input and enters edit mode with full text", async () => {
    const interruptStream = mock(() => Promise.resolve({ success: true }));

    const client = {
      workspace: {
        interruptStream,
      },
    } as unknown as APIClient;

    const aggregator = {
      getAllMessages: () => [
        {
          id: "user-1",
          role: "user",
          metadata: {
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact -t 100",
              parsed: { continueMessage: { text: "Do the thing" } },
            },
          },
        },
      ],
    } as unknown as Parameters<typeof cancelCompaction>[2];

    const startEditingMessage = mock(() => undefined);

    const result = await cancelCompaction(client, "ws-1", aggregator, startEditingMessage);

    expect(result).toBe(true);
    expect(interruptStream).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      options: { abandonPartial: true, restoreQueuedToInput: false },
    });
    expect(startEditingMessage).toHaveBeenCalledWith("user-1", "/compact -t 100\nDo the thing");
  });
});
