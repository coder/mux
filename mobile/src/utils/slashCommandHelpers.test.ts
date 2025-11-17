import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { buildMobileCompactionPayload, filterSuggestionsForMobile } from "./slashCommandHelpers";
import type { SendMessageOptions } from "../api/client";

describe("filterSuggestionsForMobile", () => {
  it("filters out hidden commands by root key", () => {
    const suggestions: SlashSuggestion[] = [
      {
        id: "command:model",
        display: "/model",
        description: "Select model",
        replacement: "/model opus",
      },
      {
        id: "command:telemetry:on",
        display: "/telemetry",
        description: "Enable telemetry",
        replacement: "/telemetry on",
      },
      {
        id: "command:vim",
        display: "/vim",
        description: "Toggle Vim mode",
        replacement: "/vim",
      },
    ];

    const filtered = filterSuggestionsForMobile(suggestions);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.display).toBe("/model");
  });
});

describe("buildMobileCompactionPayload", () => {
  it("builds text, metadata, and overrides from parsed command", () => {
    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-sonnet-4-5",
      mode: "plan",
      thinkingLevel: "default",
    };

    const parsed = {
      type: "compact" as const,
      maxOutputTokens: 800,
      continueMessage: "Continue by summarizing TODOs",
      model: "anthropic:claude-opus-4-1",
    };

    const payload = buildMobileCompactionPayload(parsed, baseOptions);

    expect(payload.messageText).toContain("approximately 615 words");
    expect(payload.messageText).toContain(parsed.continueMessage);
    expect(payload.metadata.type).toBe("compaction-request");
    expect(payload.metadata.rawCommand).toContain("/compact -t 800 -m anthropic:claude-opus-4-1");
    expect(payload.metadata.parsed).toEqual({
      model: "anthropic:claude-opus-4-1",
      maxOutputTokens: 800,
      continueMessage: parsed.continueMessage,
    });
    expect(payload.sendOptions.model).toBe("anthropic:claude-opus-4-1");
    expect(payload.sendOptions.mode).toBe("compact");
    expect(payload.sendOptions.maxOutputTokens).toBe(800);
  });
});
