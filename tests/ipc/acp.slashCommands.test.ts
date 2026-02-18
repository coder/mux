import type { AgentSkillDescriptor } from "../../src/common/types/agentSkill";
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

  it("parses /compact flags and multiline follow-up", () => {
    const parsed = parseAcpSlashCommand(
      "/compact -t 1200 -m haiku\nContinue with focused tests",
      mapSkillsByName(skills)
    );

    expect(parsed?.kind).toBe("compact");
    if (parsed == null || parsed.kind !== "compact") {
      throw new Error("Expected /compact command to parse");
    }

    expect(parsed.maxOutputTokens).toBe(1200);
    expect(parsed.model).toBeDefined();
    expect(parsed.model).toContain(":");
    expect(parsed.continueMessage).toBe("Continue with focused tests");
  });

  it("rejects invalid /new runtime arguments", () => {
    const invalid = parseAcpSlashCommand("/new feature-branch -r ssh", mapSkillsByName(skills));
    expect(invalid?.kind).toBe("invalid");

    const parsed = parseAcpSlashCommand(
      '/new feature-branch -t main -r "ssh user@example.com"\nStart by summarizing the branch',
      mapSkillsByName(skills)
    );

    expect(parsed?.kind).toBe("new");
    if (parsed == null || parsed.kind !== "new") {
      throw new Error("Expected /new command to parse");
    }

    expect(parsed.workspaceName).toBe("feature-branch");
    expect(parsed.trunkBranch).toBe("main");
    expect(parsed.runtimeConfig?.type).toBe("ssh");
    if (parsed.runtimeConfig?.type === "ssh") {
      expect(parsed.runtimeConfig.host).toBe("user@example.com");
    }
    expect(parsed.startMessage).toBe("Start by summarizing the branch");
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
