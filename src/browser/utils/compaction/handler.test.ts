import { describe, expect, test, mock } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { cancelCompaction } from "./handler";

describe("cancelCompaction", () => {
  test("enters edit mode with full text before interrupting", async () => {
    const calls: string[] = [];

    const interruptStream = mock(() => {
      calls.push("interrupt");
      return Promise.resolve({ success: true });
    });

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
              parsed: { followUpContent: { text: "Do the thing" } },
            },
          },
        },
      ],
    } as unknown as Parameters<typeof cancelCompaction>[2];

    const startEditingMessage = mock(() => {
      calls.push("edit");
      return undefined;
    });

    const result = await cancelCompaction(client, "ws-1", aggregator, startEditingMessage);

    expect(result).toBe(true);
    expect(startEditingMessage).toHaveBeenCalledWith({
      id: "user-1",
      pending: {
        content: "/compact -t 100\nDo the thing",
        fileParts: [],
        reviews: [],
      },
    });
    expect(interruptStream).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      options: { abandonPartial: true },
    });
    expect(calls).toEqual(["edit", "interrupt"]);
  });

  test("preserves follow-up attachments and reviews on cancel", async () => {
    const calls: string[] = [];

    const interruptStream = mock(() => {
      calls.push("interrupt");
      return Promise.resolve({ success: true });
    });

    const client = {
      workspace: {
        interruptStream,
      },
    } as unknown as APIClient;

    const mockFilePart = {
      type: "file" as const,
      data: "data",
      name: "test.txt",
      mimeType: "text/plain",
    };
    const mockReview = { noteText: "Fix this bug", filePath: "src/app.ts" };

    const aggregator = {
      getAllMessages: () => [
        {
          id: "user-2",
          role: "user",
          metadata: {
            muxMetadata: {
              type: "compaction-request",
              rawCommand: "/compact",
              parsed: {
                followUpContent: {
                  text: "Continue work",
                  fileParts: [mockFilePart],
                  reviews: [mockReview],
                },
              },
            },
          },
        },
      ],
    } as unknown as Parameters<typeof cancelCompaction>[2];

    const startEditingMessage = mock(() => {
      calls.push("edit");
      return undefined;
    });

    const result = await cancelCompaction(client, "ws-2", aggregator, startEditingMessage);

    expect(result).toBe(true);
    expect(startEditingMessage).toHaveBeenCalledWith({
      id: "user-2",
      pending: {
        content: "/compact\nContinue work",
        fileParts: [mockFilePart],
        reviews: [mockReview],
      },
    });
    expect(calls).toEqual(["edit", "interrupt"]);
  });
});
