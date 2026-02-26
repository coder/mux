import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { REDACTED_SECRET_VALUE } from "@/node/services/tools/shared/configRedaction";

import { createMuxConfigReadTool } from "./mux_config_read";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

interface MuxConfigReadSuccess {
  success: true;
  file: "providers" | "config";
  data: unknown;
}

interface MuxConfigReadError {
  success: false;
  error: string;
}

type MuxConfigReadResult = MuxConfigReadSuccess | MuxConfigReadError;

async function createReadTool(muxHomeDir: string, workspaceId: string) {
  const workspaceSessionDir = path.join(muxHomeDir, "sessions", workspaceId);
  await fs.mkdir(workspaceSessionDir, { recursive: true });

  const config = createTestToolConfig(muxHomeDir, {
    workspaceId,
    sessionsDir: workspaceSessionDir,
  });

  return createMuxConfigReadTool(config);
}

describe("mux_config_read", () => {
  it("enforces Chat with Mux workspace scope", async () => {
    using muxHome = new TestTempDir("mux-config-read");

    const tool = await createReadTool(muxHome.path, "regular-workspace");
    const result = (await tool.execute!(
      { file: "providers" },
      mockToolCallOptions
    )) as MuxConfigReadResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("only available");
    }
  });

  it("returns redacted providers data for full and path reads", async () => {
    using muxHome = new TestTempDir("mux-config-read");

    await fs.writeFile(
      path.join(muxHome.path, "providers.jsonc"),
      JSON.stringify(
        {
          anthropic: {
            apiKey: "sk-ant-secret",
            headers: {
              Authorization: "Bearer super-secret",
              "x-trace-id": "safe-value",
            },
          },
          openrouter: {
            apiKey: "or-secret",
            order: "quality",
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const tool = await createReadTool(muxHome.path, MUX_HELP_CHAT_WORKSPACE_ID);

    const fullResult = (await tool.execute!(
      { file: "providers" },
      mockToolCallOptions
    )) as MuxConfigReadResult;

    expect(fullResult.success).toBe(true);
    if (fullResult.success) {
      expect(fullResult.data).toMatchObject({
        anthropic: {
          apiKey: REDACTED_SECRET_VALUE,
          headers: {
            Authorization: REDACTED_SECRET_VALUE,
            "x-trace-id": "safe-value",
          },
        },
        openrouter: {
          apiKey: REDACTED_SECRET_VALUE,
          order: "quality",
        },
      });

      const serialized = JSON.stringify(fullResult.data);
      expect(serialized).not.toContain("sk-ant-secret");
      expect(serialized).not.toContain("or-secret");
      expect(serialized).not.toContain("super-secret");
    }

    const pathResult = (await tool.execute!(
      { file: "providers", path: ["anthropic", "apiKey"] },
      mockToolCallOptions
    )) as MuxConfigReadResult;

    expect(pathResult.success).toBe(true);
    if (pathResult.success) {
      expect(pathResult.data).toBe(REDACTED_SECRET_VALUE);
    }
  });

  it("redacts config token fields", async () => {
    using muxHome = new TestTempDir("mux-config-read");

    await fs.writeFile(
      path.join(muxHome.path, "config.json"),
      JSON.stringify(
        {
          muxGovernorToken: "token-123",
          defaultModel: "anthropic:claude-sonnet-4-20250514",
        },
        null,
        2
      ),
      "utf-8"
    );

    const tool = await createReadTool(muxHome.path, MUX_HELP_CHAT_WORKSPACE_ID);

    const result = (await tool.execute!(
      { file: "config" },
      mockToolCallOptions
    )) as MuxConfigReadResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        muxGovernorToken: REDACTED_SECRET_VALUE,
        defaultModel: "anthropic:claude-sonnet-4-20250514",
      });

      expect(JSON.stringify(result.data)).not.toContain("token-123");
    }
  });

  it("returns null for inherited prototype property names in path", async () => {
    using muxHome = new TestTempDir("mux-config-read");

    await fs.writeFile(
      path.join(muxHome.path, "config.json"),
      JSON.stringify({ defaultModel: "anthropic:claude-sonnet-4-20250514" }, null, 2),
      "utf-8"
    );

    const tool = await createReadTool(muxHome.path, MUX_HELP_CHAT_WORKSPACE_ID);

    // "constructor" is inherited from Object.prototype — must not be traversable
    const constructorResult = (await tool.execute!(
      { file: "config", path: ["constructor"] },
      mockToolCallOptions
    )) as MuxConfigReadResult;
    expect(constructorResult.success).toBe(true);
    if (constructorResult.success) {
      expect(constructorResult.data).toBeNull();
    }

    // Nested prototype traversal: ["constructor", "name"] would yield "Object" without fix
    const nestedResult = (await tool.execute!(
      { file: "config", path: ["constructor", "name"] },
      mockToolCallOptions
    )) as MuxConfigReadResult;
    expect(nestedResult.success).toBe(true);
    if (nestedResult.success) {
      expect(nestedResult.data).toBeNull();
    }
  });
});
