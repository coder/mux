import { describe, expect, test } from "bun:test";

import { AgentReportToolCall } from "../AgentReportToolCall";
import { AgentSkillReadFileToolCall } from "../AgentSkillReadFileToolCall";
import { AgentSkillReadToolCall } from "../AgentSkillReadToolCall";
import { CompleteGoalToolCall } from "../CompleteGoalToolCall";
import { DesktopActionToolCall } from "../DesktopActionToolCall";
import { DesktopScreenshotToolCall } from "../DesktopScreenshotToolCall";
import { GenericToolCall } from "../GenericToolCall";
import { GoogleSearchToolCall } from "../GoogleSearchToolCall";
import { SetGoalToolCall } from "../SetGoalToolCall";
import { WorkflowResumeToolCall, WorkflowRunToolCall } from "../WorkflowRunToolCall";
import { WorkflowListToolCall, WorkflowReadToolCall } from "../WorkflowDefinitionToolCall";
import { GetGoalToolCall } from "../GetGoalToolCall";
import { getToolComponent } from "./getToolComponent";

describe("getToolComponent", () => {
  test("returns workflow definition tool components", () => {
    expect(getToolComponent("workflow_list", {})).toBe(WorkflowListToolCall);
    expect(getToolComponent("workflow_read", { name: "deep-research" })).toBe(WorkflowReadToolCall);
  });

  test("returns WorkflowRunToolCall for workflow_run", () => {
    const component = getToolComponent("workflow_run", { name: "deep-research" });
    expect(component).toBe(WorkflowRunToolCall);
  });

  test("returns WorkflowResumeToolCall for workflow_resume", () => {
    const component = getToolComponent("workflow_resume", { run_id: "wfr_123" });
    expect(component).toBe(WorkflowResumeToolCall);
  });

  test("returns AgentReportToolCall for agent_report", () => {
    const component = getToolComponent("agent_report", { reportMarkdown: "# Hello" });
    expect(component).toBe(AgentReportToolCall);
  });

  test("returns AgentReportToolCall for legacy file-backed agent_report transcripts", () => {
    const component = getToolComponent("agent_report", {
      reportMarkdownPath: "report.md",
      structuredOutputPath: "structured-output.json",
      title: null,
    });
    expect(component).toBe(AgentReportToolCall);
  });

  test("returns AgentReportToolCall for empty legacy file-backed agent_report input", () => {
    expect(getToolComponent("agent_report", {})).toBe(AgentReportToolCall);
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

  test("returns DesktopScreenshotToolCall for desktop_screenshot", () => {
    const component = getToolComponent("desktop_screenshot", { scaledWidth: 640 });
    expect(component).toBe(DesktopScreenshotToolCall);
  });

  test("returns DesktopActionToolCall for desktop_click", () => {
    const component = getToolComponent("desktop_click", { x: 12, y: 34 });
    expect(component).toBe(DesktopActionToolCall);
  });

  test("returns SetGoalToolCall for set_goal", () => {
    const component = getToolComponent("set_goal", { objective: "Ship it" });
    expect(component).toBe(SetGoalToolCall);
  });

  test("returns GetGoalToolCall for get_goal", () => {
    const component = getToolComponent("get_goal", {});
    expect(component).toBe(GetGoalToolCall);
  });

  test("returns CompleteGoalToolCall for complete_goal", () => {
    const component = getToolComponent("complete_goal", { summary: "Done." });
    expect(component).toBe(CompleteGoalToolCall);
  });

  test("complete_goal falls back to GenericToolCall when summary is empty (zod min(1) fails)", () => {
    const component = getToolComponent("complete_goal", { summary: "" });
    expect(component).toBe(GenericToolCall);
  });

  test("falls back to GenericToolCall when args validation fails", () => {
    const component = getToolComponent("agent_report", { reportMarkdown: "" });
    expect(component).toBe(GenericToolCall);
  });

  test("returns GoogleSearchToolCall for server:GOOGLE_SEARCH_WEB", () => {
    expect(getToolComponent("server:GOOGLE_SEARCH_WEB", { queries: ["gemini 3 pricing"] })).toBe(
      GoogleSearchToolCall
    );
    // Streaming/pending args (not yet parsed) must not bounce to the generic renderer.
    expect(getToolComponent("server:GOOGLE_SEARCH_WEB", {})).toBe(GoogleSearchToolCall);
  });

  test("server:GOOGLE_SEARCH_WEB falls back to GenericToolCall when args don't conform", () => {
    const component = getToolComponent("server:GOOGLE_SEARCH_WEB", { queries: "not-an-array" });
    expect(component).toBe(GenericToolCall);
  });

  test("Object.prototype member names fall back to GenericToolCall instead of throwing", () => {
    // toolName flows verbatim from persisted transcripts; inherited members of the
    // registry object must not be treated as entries (self-healing invariant).
    expect(getToolComponent("constructor", {})).toBe(GenericToolCall);
    expect(getToolComponent("__proto__", {})).toBe(GenericToolCall);
    expect(getToolComponent("toString", {})).toBe(GenericToolCall);
  });
});
