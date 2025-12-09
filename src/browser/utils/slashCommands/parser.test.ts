import { describe, it, expect } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { parseCommand } from "./parser";

// Test helpers
const expectParse = (input: string, expected: ReturnType<typeof parseCommand>) => {
  expect(parseCommand(input)).toEqual(expected);
};

const expectProvidersSet = (input: string, provider: string, keyPath: string[], value: string) => {
  expectParse(input, { type: "providers-set", provider, keyPath, value });
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

    it("should parse /providers help when no subcommand", () => {
      expectParse("/providers", { type: "providers-help" });
    });

    it("should parse /providers with invalid subcommand", () => {
      expectParse("/providers invalid", {
        type: "providers-invalid-subcommand",
        subcommand: "invalid",
      });
    });

    it("should parse /providers set with missing args", () => {
      const missingArgsCases = [
        { input: "/providers set", argCount: 0 },
        { input: "/providers set anthropic", argCount: 1 },
        { input: "/providers set anthropic apiKey", argCount: 2 },
      ];

      missingArgsCases.forEach(({ input, argCount }) => {
        expectParse(input, {
          type: "providers-missing-args",
          subcommand: "set",
          argCount,
        });
      });
    });

    it("should parse /providers set with all arguments", () => {
      expectProvidersSet(
        "/providers set anthropic apiKey sk-123",
        "anthropic",
        ["apiKey"],
        "sk-123"
      );
    });

    it("should handle quoted arguments", () => {
      expectProvidersSet(
        '/providers set anthropic apiKey "my key with spaces"',
        "anthropic",
        ["apiKey"],
        "my key with spaces"
      );
    });

    it("should handle multiple spaces in value", () => {
      expectProvidersSet(
        "/providers set anthropic apiKey My Anthropic API",
        "anthropic",
        ["apiKey"],
        "My Anthropic API"
      );
    });

    it("should handle nested key paths", () => {
      expectProvidersSet(
        "/providers set anthropic baseUrl.scheme https",
        "anthropic",
        ["baseUrl", "scheme"],
        "https"
      );
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

    it("should handle multiple spaces between arguments", () => {
      expectProvidersSet(
        "/providers   set   anthropic   apiKey   sk-12345",
        "anthropic",
        ["apiKey"],
        "sk-12345"
      );
    });

    it("should handle quoted URL values", () => {
      expectProvidersSet(
        '/providers set anthropic baseUrl "https://api.anthropic.com/v1"',
        "anthropic",
        ["baseUrl"],
        "https://api.anthropic.com/v1"
      );
    });

    it("should parse /model with abbreviation", () => {
      expectModelSet("/model opus", KNOWN_MODELS.OPUS.id);
    });

    it("should parse /model with full provider:model format", () => {
      expectModelSet("/model anthropic:claude-sonnet-4-5", KNOWN_MODELS.SONNET.id);
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
