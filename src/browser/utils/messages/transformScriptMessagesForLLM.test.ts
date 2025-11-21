import { describe, it, expect } from "@jest/globals";
import { transformScriptMessagesForLLM } from "./modelMessageTransform";
import type { MuxMessage } from "@/common/types/message";
import type { BashToolResult } from "@/common/types/tools";

describe("transformScriptMessagesForLLM", () => {
  it("should include stdout/stderr in script execution messages", () => {
    const scriptResult: BashToolResult = {
      success: true,
      output: "some stdout output",
      exitCode: 0,
      wall_duration_ms: 100,
    };

    const messages: MuxMessage[] = [
      {
        id: "script-1",
        role: "user",
        parts: [{ type: "text", text: "Executed script: /script test" }],
        metadata: {
          muxMetadata: {
            type: "script-execution",
            id: "script-1",
            historySequence: 0,
            timestamp: 123,
            command: "/script test",
            scriptName: "test.sh",
            args: [],
            result: scriptResult,
          },
        },
      },
    ];

    const result = transformScriptMessagesForLLM(messages);
    expect(result).toHaveLength(1);
    const textPart = result[0].parts[0];
    expect(textPart.type).toBe("text");
    if (textPart.type === "text") {
      expect(textPart.text).toContain("Script 'test.sh' executed");
      expect(textPart.text).toContain("Stdout/Stderr:");
      expect(textPart.text).toContain("some stdout output");
    }
  });

  it("should exclude MUX_OUTPUT and MUX_PROMPT from script execution messages (avoid duplication)", () => {
    const scriptResult: BashToolResult = {
      success: true,
      output: "stdout stuff",
      exitCode: 0,
      wall_duration_ms: 100,
      outputFile: "User toast",
      promptFile: "Model prompt",
    };

    const messages: MuxMessage[] = [
      {
        id: "script-all",
        role: "user",
        parts: [{ type: "text", text: "Executed script: /script all" }],
        metadata: {
          muxMetadata: {
            type: "script-execution",
            id: "script-all",
            historySequence: 0,
            timestamp: 123,
            command: "/script all",
            scriptName: "all.sh",
            args: [],
            result: scriptResult,
          },
        },
      },
    ];

    const result = transformScriptMessagesForLLM(messages);
    expect(result).toHaveLength(1);
    const textPart = result[0].parts[0];
    expect(textPart.type).toBe("text");
    if (textPart.type === "text") {
      expect(textPart.text).not.toContain("MUX_OUTPUT");
      expect(textPart.text).not.toContain("User toast");
      expect(textPart.text).not.toContain("MUX_PROMPT");
      expect(textPart.text).not.toContain("Model prompt");
    }
  });

  it("should surface error details when script fails without output", () => {
    const scriptResult: BashToolResult = {
      success: false,
      exitCode: 2,
      wall_duration_ms: 120,
      error: "Permission denied",
    };

    const messages: MuxMessage[] = [
      {
        id: "script-error",
        role: "user",
        parts: [{ type: "text", text: "Executed script: /script fail" }],
        metadata: {
          muxMetadata: {
            type: "script-execution",
            id: "script-error",
            historySequence: 0,
            timestamp: 999,
            command: "/script fail",
            scriptName: "fail.sh",
            args: [],
            result: scriptResult,
          },
        },
      },
    ];

    const result = transformScriptMessagesForLLM(messages);
    expect(result).toHaveLength(1);
    const textPart = result[0].parts[0];
    expect(textPart.type).toBe("text");
    if (textPart.type === "text") {
      expect(textPart.text).toContain("Stdout/Stderr: (no output)");
      expect(textPart.text).toContain("Error:");
      expect(textPart.text).toContain("Permission denied");
    }
  });
});
