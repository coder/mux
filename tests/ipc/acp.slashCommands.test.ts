import type { AgentSkillDescriptor } from "../../src/common/types/agentSkill";
import { KNOWN_MODELS } from "../../src/common/constants/knownModels";
import {
  buildAcpAvailableCommands,
  mapSkillsByName,
  parseAcpSlashCommand,
} from "../../src/node/acp/slashCommands";

describe("ACP slash command support", () => {
  const skills: AgentSkillDescriptor[] = [
    {
      name: "react-effects",
      description: "Guidance on avoiding unnecessary useEffect",
      scope: "project",
    },
    {
      name: "clear",
      description: "Conflicting skill name should not be advertised as command",
      scope: "global",
    },
    {
      name: "deep-review",
      description: "Hidden skill",
      scope: "built-in",
      advertise: false,
    },
  ];

  it("builds ACP available command list with server commands and advertised skills", () => {
    const availableCommands = buildAcpAvailableCommands(skills);
    const commandNames = availableCommands.map((command) => command.name);

    expect(commandNames).toEqual(["clear", "truncate", "compact", "fork", "new", "react-effects"]);

    const skillCommand = availableCommands.find((command) => command.name === "react-effects");
    expect(skillCommand).toBeDefined();
    expect(skillCommand?.description).toContain("Guidance on avoiding unnecessary useEffect");
    expect(skillCommand?.input?.hint).toContain("Describe how to apply this skill");
  });

  it("parses /truncate commands", () => {
    const parsed = parseAcpSlashCommand("/truncate 25", mapSkillsByName(skills));
    expect(parsed).toEqual({ kind: "truncate", percentage: 0.25 });

    const trailingChars = parseAcpSlashCommand("/truncate 25oops", mapSkillsByName(skills));
    expect(trailingChars?.kind).toBe("invalid");
    const invalid = parseAcpSlashCommand("/truncate nope", mapSkillsByName(skills));
    expect(invalid?.kind).toBe("invalid");
  });

  it("rejects malformed /compact -t values", () => {
    const parsed = parseAcpSlashCommand("/compact -t 1200oops", mapSkillsByName(skills));
    expect(parsed?.kind).toBe("invalid");
  });

  it("parses /compact flags, resolves aliases, and keeps the multiline follow-up", () => {
    const parsed = parseAcpSlashCommand(
      "/compact -t 1200 -m haiku\nContinue with focused tests",
      mapSkillsByName(skills)
    );

    expect(parsed?.kind).toBe("compact");
    if (parsed == null || parsed.kind !== "compact") {
      throw new Error("Expected /compact command to parse");
    }

    expect(parsed.maxOutputTokens).toBe(1200);
    expect(parsed.model).toBe(KNOWN_MODELS.HAIKU.id);
    expect(parsed.continueMessage).toBe("Continue with focused tests");
  });

  it("preserves explicit gateway prefix in /compact -m model", () => {
    const parsed = parseAcpSlashCommand(
      "/compact -m openrouter:openai/gpt-5",
      mapSkillsByName(skills)
    );

    expect(parsed?.kind).toBe("compact");
    if (parsed == null || parsed.kind !== "compact") {
      throw new Error("Expected /compact command with explicit gateway prefix to parse");
    }

    expect(parsed.model).toBe("openrouter:openai/gpt-5");
  });

  it("preserves mux-gateway prefix in /compact -m model", () => {
    const parsed = parseAcpSlashCommand(
      "/compact -m mux-gateway:anthropic/claude-sonnet-4-6",
      mapSkillsByName(skills)
    );

    expect(parsed?.kind).toBe("compact");
    if (parsed == null || parsed.kind !== "compact") {
      throw new Error("Expected /compact command with mux-gateway prefix to parse");
    }

    expect(parsed.model).toBe("mux-gateway:anthropic/claude-sonnet-4-6");
  });

  it("rejects invalid model ids in /compact -m", () => {
    const parsed = parseAcpSlashCommand("/compact -m openai::gpt-5", mapSkillsByName(skills));

    expect(parsed).toEqual({
      kind: "invalid",
      message: 'Invalid model "openai::gpt-5". Expected "provider:model" or a known alias.',
    });
  });

  it("parses /compact flags and one-line follow-up", () => {
    const parsed = parseAcpSlashCommand(
      "/compact -t 1200 Continue with focused tests",
      mapSkillsByName(skills)
    );

    expect(parsed?.kind).toBe("compact");
    if (parsed == null || parsed.kind !== "compact") {
      throw new Error("Expected one-line /compact command to parse");
    }

    expect(parsed.maxOutputTokens).toBe(1200);
    expect(parsed.continueMessage).toBe("Continue with focused tests");
  });

  it("parses /compact one-line follow-up containing numbers", () => {
    const parsed = parseAcpSlashCommand(
      "/compact -t 1200 continue in 2 steps",
      mapSkillsByName(skills)
    );

    expect(parsed?.kind).toBe("compact");
    if (parsed == null || parsed.kind !== "compact") {
      throw new Error("Expected numeric one-line /compact command to parse");
    }

    expect(parsed.continueMessage).toBe("continue in 2 steps");
  });

  // /new now mirrors /fork — there is no workspace name argument and no
  // -t/-r flags. Everything after `/new` is the optional start message and
  // the backend handles auto-naming + pendingAutoTitle.
  it("parses /new with no arguments", () => {
    expect(parseAcpSlashCommand("/new", mapSkillsByName(skills))).toEqual({
      kind: "new",
      startMessage: undefined,
    });
  });

  it("captures the rest of the input as the start message", () => {
    expect(
      parseAcpSlashCommand("/new Start by summarizing the branch", mapSkillsByName(skills))
    ).toEqual({
      kind: "new",
      startMessage: "Start by summarizing the branch",
    });
  });

  it("preserves multiline start messages", () => {
    expect(parseAcpSlashCommand("/new\nLine one\nLine two", mapSkillsByName(skills))).toEqual({
      kind: "new",
      startMessage: "Line one\nLine two",
    });
  });

  it("maps skill slash commands to formatted prompts", () => {
    const skillsByName = mapSkillsByName(skills);

    const parsed = parseAcpSlashCommand("/react-effects reduce useEffect churn", skillsByName);
    expect(parsed?.kind).toBe("skill");
    if (parsed == null || parsed.kind !== "skill") {
      throw new Error("Expected skill command to parse");
    }

    expect(parsed.descriptor.name).toBe("react-effects");
    expect(parsed.formattedMessage).toBe("Using skill react-effects: reduce useEffect churn");

    const noArgs = parseAcpSlashCommand("/react-effects", skillsByName);
    expect(noArgs?.kind).toBe("skill");
    if (noArgs == null || noArgs.kind !== "skill") {
      throw new Error("Expected skill command without args to parse");
    }

    expect(noArgs.formattedMessage).toBe("Use skill react-effects");
  });

  it("leaves unknown slash commands untouched for normal prompt handling", () => {
    const parsed = parseAcpSlashCommand("/vim", mapSkillsByName(skills));
    expect(parsed).toBeNull();
  });
});
