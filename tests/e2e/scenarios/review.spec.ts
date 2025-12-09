import { electronTest as test } from "../electronTest";
import { REVIEW_PROMPTS } from "@/node/services/mock/scenarios/review";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test("review scenario", async ({ ui }) => {
  await ui.projects.openFirstWorkspace();
  await ui.chat.setMode("Plan");
  await ui.chat.setThinkingLevel(2);
  await ui.chat.sendMessage(REVIEW_PROMPTS.SUMMARIZE_BRANCHES);
  await ui.chat.expectTranscriptContains("Here’s the current branch roster");

  await ui.chat.setMode("Exec");
  await ui.chat.setThinkingLevel(1);
  await ui.chat.sendMessage(REVIEW_PROMPTS.OPEN_ONBOARDING_DOC);
  await ui.chat.expectActionButtonVisible("Edit");
  await ui.chat.expectTranscriptContains("ENOENT: docs/onboarding.md not found");

  await ui.chat.clickActionButton("Edit");
  await ui.chat.sendMessage(REVIEW_PROMPTS.SHOW_ONBOARDING_DOC);
  await ui.chat.expectTranscriptContains("Found it. Here’s the quick-start summary:");

  await ui.chat.sendCommandAndExpectStatus("/truncate 50", "Chat history truncated");

  await ui.metaSidebar.expectVisible();
  await ui.metaSidebar.selectTab("Review");
  await ui.metaSidebar.selectTab("Costs");
});
