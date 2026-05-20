import { parseCommand } from "./parser";

describe("/btw command", () => {
  it("parses /btw with a question", () => {
    const result = parseCommand("/btw what file did you just edit?");
    expect(result).toEqual({
      type: "side-question",
      question: "what file did you just edit?",
    });
  });

  it("preserves spaces, quotes, and punctuation in the question", () => {
    const result = parseCommand('/btw why "exec-only" mode? Is it costlier?');
    expect(result).toEqual({
      type: "side-question",
      question: 'why "exec-only" mode? Is it costlier?',
    });
  });

  it("returns command-missing-args when no question is provided", () => {
    const result = parseCommand("/btw");
    expect(result).toMatchObject({
      type: "command-missing-args",
      command: "btw",
    });
  });

  it("treats whitespace-only input as missing args", () => {
    const result = parseCommand("/btw    ");
    expect(result).toMatchObject({
      type: "command-missing-args",
      command: "btw",
    });
  });
});
