import { describe, expect, test } from "bun:test";

import { AgentReportToolCall } from "../AgentReportToolCall";
import { AgentSkillReadFileToolCall } from "../AgentSkillReadFileToolCall";
import { AgentSkillReadToolCall } from "../AgentSkillReadToolCall";
import { GenericToolCall } from "../GenericToolCall";
import { getToolComponent } from "./getToolComponent";

describe("getToolComponent", () => {
  test("returns AgentReportToolCall for agent_report", () => {
    const component = getToolComponent("agent_report", { reportMarkdown: "# Hello" });
    expect(component).toBe(AgentReportToolCall);
  });

  test("returns AgentSkillReadToolCall for agent_skill_read", () => {
    const component = getToolComponent("agent_skill_read", { name: "react-effects" });
    expect(component).toBe(AgentSkillReadToolCall);
  });

  test("returns AgentSkillReadFileToolCall for agent_skill_read_file", () => {
    const component = getToolComponent("agent_skill_read_file", {
      name: "react-effects",
      filePath: "references/README.md",
    });
    expect(component).toBe(AgentSkillReadFileToolCall);
  });

  test("falls back to GenericToolCall when args validation fails", () => {
    const component = getToolComponent("agent_report", { reportMarkdown: "" });
    expect(component).toBe(GenericToolCall);
  });
});
