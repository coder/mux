import { electronTest as test, electronExpect as expect } from "../electronTest";
import { MOCK_PERMISSION_MODE_PROMPTS } from "../mockAiPrompts";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("permission mode behavior", () => {
  test("plan mode streams plan-only response", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();
    await ui.chat.setMode("Plan");

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_PERMISSION_MODE_PROMPTS.PLAN_REFACTOR);
    });

    if (timeline.events.length === 0) {
      throw new Error("Plan mode timeline must contain events");
    }

    const eventTypes = timeline.events.map((event) => event.type);
    expect(eventTypes[0]).toBe("stream-start");
    expect(eventTypes[eventTypes.length - 1]).toBe("stream-end");
    expect(eventTypes.includes("tool-call-start")).toBe(false);
    expect(eventTypes.includes("tool-call-end")).toBe(false);

    await ui.chat.expectTranscriptContains("Plan summary:");
    await ui.chat.expectTranscriptContains("Extract validation into verifyInputs().");
  });

  test("exec mode performs tool call and reports results", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();
    await ui.chat.setMode("Exec");

    const timeline = await ui.chat.captureStreamTimeline(async () => {
      await ui.chat.sendMessage(MOCK_PERMISSION_MODE_PROMPTS.EXECUTE_PLAN);
    });

    if (timeline.events.length === 0) {
      throw new Error("Exec mode timeline must contain events");
    }

    const eventTypes = timeline.events.map((event) => event.type);
    const toolStartIndex = eventTypes.indexOf("tool-call-start");
    const toolEndIndex = eventTypes.indexOf("tool-call-end");
    expect(toolStartIndex).toBeGreaterThanOrEqual(0);
    expect(toolEndIndex).toBeGreaterThan(toolStartIndex);

    const toolStart = timeline.events[toolStartIndex];
    if (!toolStart) {
      throw new Error("Missing tool-call-start event in exec mode timeline");
    }
    expect(toolStart.toolName).toBe("bash");

    const toolEnd = timeline.events[toolEndIndex];
    if (!toolEnd) {
      throw new Error("Missing tool-call-end event in exec mode timeline");
    }
    expect(toolEnd.toolName).toBe("bash");
    expect(toolEnd.result).toMatchObject({ success: true });

    await ui.chat.expectTranscriptContains("Applied refactor plan:");
    await ui.chat.expectTranscriptContains("Updated src/utils/legacyFunction.ts");
  });
});
