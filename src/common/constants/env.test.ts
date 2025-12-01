import { NON_INTERACTIVE_ENV_VARS } from "./env";

describe("NON_INTERACTIVE_ENV_VARS", () => {
  it("should include MUX_AGENT=1", () => {
    expect(NON_INTERACTIVE_ENV_VARS.MUX_AGENT).toBe("1");
  });

  it("should include all expected env vars", () => {
    expect(NON_INTERACTIVE_ENV_VARS).toMatchObject({
      MUX_AGENT: "1",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      EDITOR: "true",
      VISUAL: "true",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});
