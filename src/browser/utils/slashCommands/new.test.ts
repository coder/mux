import { parseCommand } from "./parser";

// /new mirrors /fork: there is no required workspace name. Everything after
// `/new` becomes the optional start message; the backend auto-generates the
// branch name and (when a start message is provided) fills in the title.
describe("/new command", () => {
  it("parses bare /new as a no-arg seamless creation", () => {
    expect(parseCommand("/new")).toEqual({ type: "new" });
  });

  it("treats trailing whitespace as no start message", () => {
    expect(parseCommand("/new   ")).toEqual({ type: "new" });
  });

  it("captures the rest of the line as the start message", () => {
    expect(parseCommand("/new Build authentication system")).toEqual({
      type: "new",
      startMessage: "Build authentication system",
    });
  });

  it("preserves multiline start messages", () => {
    expect(parseCommand("/new Build feature X\nWith follow-up details")).toEqual({
      type: "new",
      startMessage: "Build feature X\nWith follow-up details",
    });
  });

  it("supports start messages on the line below /new", () => {
    expect(parseCommand("/new\nStart implementing feature X")).toEqual({
      type: "new",
      startMessage: "Start implementing feature X",
    });
  });
});
