import { describe, expect, it } from "bun:test";

import { buildIterationPrompt } from "./loopRunnerService";

describe("buildIterationPrompt", () => {
  it("includes item id + journal guidance", () => {
    const prompt = buildIterationPrompt({
      iteration: 3,
      itemId: "item-1",
      itemTitle: "Do something",
      configPathHint: ".mux/harness/branch.jsonc",
      progressPathHint: ".mux/harness/branch.progress.md",
    });

    expect(prompt).toContain("Checklist item: item-1 — Do something");
    expect(prompt).toContain("skim the journal");
    expect(prompt).toContain("append a short entry");
    expect(prompt).toContain("Journal: .mux/harness/branch.progress.md");
    expect(prompt).toContain("Config: .mux/harness/branch.jsonc");
  });
});
