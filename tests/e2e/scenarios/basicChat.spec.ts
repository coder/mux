import { electronTest as test, electronExpect as expect } from "../electronTest";
import { MOCK_LIST_PROGRAMMING_LANGUAGES } from "../mockAiPrompts";

const SIMPLE_PROMPT = MOCK_LIST_PROGRAMMING_LANGUAGES;

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test("basic chat streaming flow", async ({ ui }) => {
  await ui.projects.openFirstWorkspace();

  const timeline = await ui.chat.captureStreamTimeline(async () => {
    await ui.chat.sendMessage(SIMPLE_PROMPT);
  });

  expect(timeline.events.length).toBeGreaterThan(0);
  const eventTypes = timeline.events.map((event) => event.type);
  expect(eventTypes[0]).toBe("stream-start");
  const deltaCount = eventTypes.filter((type) => type === "stream-delta").length;
  expect(deltaCount).toBeGreaterThan(1);
  expect(eventTypes[eventTypes.length - 1]).toBe("stream-end");

  await ui.chat.expectTranscriptContains("Here are three programming languages");
  await ui.chat.expectTranscriptContains("Python");
  await ui.chat.expectTranscriptContains("JavaScript");
  await ui.chat.expectTranscriptContains("Rust");
});
