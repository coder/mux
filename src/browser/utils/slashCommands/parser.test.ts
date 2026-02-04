import { describe, it, expect } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { parseCommand } from "./parser";

// Test helpers
const expectParse = (input: string, expected: ReturnType<typeof parseCommand>) => {
  expect(parseCommand(input)).toEqual(expected);
};

const expectModelSet = (input: string, modelString: string) => {
  expectParse(input, { type: "model-set", modelString });
};

describe("commandParser", () => {
  describe("parseCommand", () => {
    it("should return null for non-command input", () => {
      expect(parseCommand("hello world")).toBeNull();
      expect(parseCommand("")).toBeNull();
      expect(parseCommand(" ")).toBeNull();
    });

    it("should parse /clear command", () => {
      expectParse("/clear", { type: "clear" });
    });

    it("treats removed /providers command as unknown", () => {
      expectParse("/providers", {
        type: "unknown-command",
        command: "providers",
        subcommand: undefined,
      });
    });

    it("should parse unknown commands", () => {
      expectParse("/foo", {
        type: "unknown-command",
        command: "foo",
        subcommand: undefined,
      });

      expectParse("/foo bar", {
        type: "unknown-command",
        command: "foo",
        subcommand: "bar",
      });
    });

    it("should parse /model with abbreviation", () => {
      expectModelSet("/model opus", KNOWN_MODELS.OPUS.id);
    });

    it("should parse /model with full provider:model format", () => {
      expectModelSet("/model anthropic:claude-sonnet-4-5", KNOWN_MODELS.SONNET.id);
    });

    it("should parse /compact -m with alias", () => {
      expectParse("/compact -m sonnet", {
        type: "compact",
        maxOutputTokens: undefined,
        continueMessage: undefined,
        model: KNOWN_MODELS.SONNET.id,
      });
    });

    it("should parse /model help when no args", () => {
      expectParse("/model", { type: "model-help" });
    });

    it("should handle unknown abbreviation as full model string", () => {
      expectModelSet("/model custom:model-name", "custom:model-name");
    });

    it("should reject /model with too many arguments", () => {
      expectParse("/model anthropic claude extra", {
        type: "unknown-command",
        command: "model",
        subcommand: "claude",
      });
    });

    it("should parse /<model-alias> as model-oneshot with message", () => {
      expectParse("/haiku check the pr", {
        type: "model-oneshot",
        modelString: KNOWN_MODELS.HAIKU.id,
        message: "check the pr",
      });
    });

    it("should parse /<model-alias> with multiline message", () => {
      expectParse("/sonnet first line\nsecond line", {
        type: "model-oneshot",
        modelString: KNOWN_MODELS.SONNET.id,
        message: "first line\nsecond line",
      });
    });

    it("should return model-help for /<model-alias> without message", () => {
      expectParse("/haiku", { type: "model-help" });
      expectParse("/sonnet  ", { type: "model-help" }); // whitespace only
    });

    it("should return unknown-command for unknown aliases", () => {
      expectParse("/xyz do something", {
        type: "unknown-command",
        command: "xyz",
        subcommand: "do",
      });
    });

    it("should not treat inherited properties as model aliases", () => {
      // Ensures we use Object.hasOwn to avoid prototype chain lookups
      expectParse("/toString hello", {
        type: "unknown-command",
        command: "toString",
        subcommand: "hello",
      });
      expectParse("/constructor test", {
        type: "unknown-command",
        command: "constructor",
        subcommand: "test",
      });
    });

    it("treats inherited properties as literal model inputs", () => {
      expectParse("/model toString", { type: "model-set", modelString: "toString" });
      expectParse("/compact -m toString", {
        type: "compact",
        maxOutputTokens: undefined,
        continueMessage: undefined,
        model: "toString",
      });
    });

    it("should parse /vim command", () => {
      expectParse("/vim", { type: "vim-toggle" });
    });

    it("should reject /vim with arguments", () => {
      expectParse("/vim enable", {
        type: "unknown-command",
        command: "vim",
        subcommand: "enable",
      });
    });

    it("should parse /fork command with name only", () => {
      expectParse("/fork feature-branch", {
        type: "fork",
        newName: "feature-branch",
        startMessage: undefined,
      });
    });

    it("should parse /fork command with start message", () => {
      expectParse("/fork feature-branch let's go", {
        type: "fork",
        newName: "feature-branch",
        startMessage: "let's go",
      });
    });

    it("should show /fork help when missing args", () => {
      expectParse("/fork", { type: "fork-help" });
    });
  });
});
it("should preserve start message when no workspace name provided", () => {
  expectParse("/new\nBuild authentication system", {
    type: "new",
    workspaceName: undefined,
    trunkBranch: undefined,
    runtime: undefined,
    startMessage: "Build authentication system",
  });
});

it("should preserve start message and flags when no workspace name", () => {
  expectParse("/new -t develop\nImplement feature X", {
    type: "new",
    workspaceName: undefined,
    trunkBranch: "develop",
    runtime: undefined,
    startMessage: "Implement feature X",
  });
});

it("should preserve start message with runtime flag when no workspace name", () => {
  expectParse('/new -r "ssh dev.example.com"\nDeploy to staging', {
    type: "new",
    workspaceName: undefined,
    trunkBranch: undefined,
    runtime: "ssh dev.example.com",
    startMessage: "Deploy to staging",
  });
});

describe("plan commands", () => {
  it("should parse /plan as plan-show", () => {
    expectParse("/plan", { type: "plan-show" });
  });

  it("should parse /plan open as plan-open", () => {
    expectParse("/plan open", { type: "plan-open" });
  });

  it("should return unknown-command for invalid /plan subcommand", () => {
    expectParse("/plan invalid", {
      type: "unknown-command",
      command: "plan",
      subcommand: "invalid",
    });
  });
});

describe("init command", () => {
  it("should parse /init as unknown-command (handled as a skill invocation)", () => {
    expectParse("/init", {
      type: "unknown-command",
      command: "init",
      subcommand: undefined,
    });
  });

  it("should parse /init with arguments as unknown-command", () => {
    expectParse("/init extra", {
      type: "unknown-command",
      command: "init",
      subcommand: "extra",
    });
  });
});
