import { describe, expect, test } from "bun:test";

import { AgentReportToolCall } from "../AgentReportToolCall";
import { GenericToolCall } from "../GenericToolCall";
import { getToolComponent } from "./getToolComponent";

describe("getToolComponent", () => {
  test("returns AgentReportToolCall for agent_report", () => {
    const component = getToolComponent("agent_report", { reportMarkdown: "# Hello" });
    expect(component).toBe(AgentReportToolCall);
  });

  test("falls back to GenericToolCall when args validation fails", () => {
    const component = getToolComponent("agent_report", { reportMarkdown: "" });
    expect(component).toBe(GenericToolCall);
  });
});
