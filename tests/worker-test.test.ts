describe("Worker test", () => {
  it("should preload tokenizers", async () => {
    console.log("Test starting...");
    const start = Date.now();
    const { loadTokenizerModules } = await import("../src/node/utils/main/tokenizer");
    console.log("Import done in", Date.now() - start, "ms");
    const result = await loadTokenizerModules(["anthropic:claude-sonnet-4-5"]);
    console.log("Result:", result, "in", Date.now() - start, "ms");
    expect(result).toHaveLength(1);
  }, 30000);
});
