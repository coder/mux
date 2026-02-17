import { describe, expect, it } from "bun:test";
import type { ToolCallOptions } from "ai";

import { createTestToolConfig, TestTempDir } from "./testHelpers";
import { createNoNewMemoriesTool } from "./no_new_memories";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

describe("no_new_memories tool", () => {
  it("returns success as an explicit no-op", async () => {
    using tempDir = new TestTempDir("test-no-new-memories");

    const config = createTestToolConfig(tempDir.path);
    const tool = createNoNewMemoriesTool(config);

    const result = (await tool.execute!({}, mockToolCallOptions)) as { success: boolean };
    expect(result).toEqual({ success: true });
  });
});
