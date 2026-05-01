import type React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { SubagentAiDefaults } from "@/common/types/tasks";
import { getThinkingOptionLabel } from "@/common/types/thinking";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";

let apiMock: {
  config: {
    getConfig: ReturnType<typeof mock>;
    saveConfig: ReturnType<typeof mock>;
  };
} | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMock }),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ selectedWorkspace: null }),
}));

void mock.module("@/browser/hooks/useExperiments", () => ({
  useExperimentValue: () => false,
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  getDefaultModel: () => "anthropic:workspace-default",
  useModelsFromSettings: () => ({
    models: [
      "anthropic:foo",
      "anthropic:ui-exec",
      "openai:gpt-5-pro",
      "openai:subagent-model",
      "xai:grok-code-fast-1",
    ],
    hiddenModelsForSelector: [],
  }),
}));

void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
}));

void mock.module("@/browser/components/ModelSelector/ModelSelector", () => ({
  ModelSelector: (props: {
    value: string;
    emptyLabel?: string;
    onChange: (value: string) => void;
    models: string[];
  }) => (
    <select
      aria-label="Model"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      <option value="">{props.emptyLabel ?? "Inherit"}</option>
      {props.models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  ),
}));

void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => ({
  Select: (props: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Reasoning"
      value={props.value}
      onChange={(event) => props.onValueChange(event.currentTarget.value)}
    >
      {props.children}
    </select>
  ),
  SelectContent: (props: { children: React.ReactNode }) => <>{props.children}</>,
  SelectItem: (props: { value: string; children: React.ReactNode }) => (
    <option value={props.value}>{props.children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import { TasksSection } from "./TasksSection";

interface RenderTasksSectionOptions {
  agentAiDefaults?: AgentAiDefaults;
  subagentAiDefaults?: SubagentAiDefaults;
}

function renderTasksSection(options: RenderTasksSectionOptions = {}) {
  const saveConfig = mock(() => Promise.resolve(undefined));
  const getConfig = mock(() =>
    Promise.resolve({
      taskSettings: {},
      agentAiDefaults: options.agentAiDefaults ?? {},
      subagentAiDefaults: options.subagentAiDefaults ?? {},
    })
  );

  apiMock = {
    config: {
      getConfig,
      saveConfig,
    },
  };

  const view = render(<TasksSection />);
  return { ...view, getConfig, saveConfig };
}

function getExecSubagentRow(view: ReturnType<typeof renderTasksSection>): HTMLElement {
  return view.getByRole("group", { name: "Exec defaults" });
}

function getAgentCardByName(
  view: ReturnType<typeof renderTasksSection>,
  name: string
): HTMLElement {
  const title = view.getByText(name);
  const card = title.closest(".rounded-md");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`Could not find ${name} agent card`);
  }
  return card;
}

function getLatestSavePayload(saveConfig: ReturnType<typeof mock>) {
  const calls = saveConfig.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as {
    agentAiDefaults: AgentAiDefaults;
    subagentAiDefaults: SubagentAiDefaults;
  };
}

describe("TasksSection Exec subagent defaults", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    apiMock = null;
  });

  afterEach(() => {
    cleanup();
    apiMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  test("renders a distinct Exec subagent row", async () => {
    const view = renderTasksSection();

    await view.findByRole("group", { name: "Exec defaults" });
    expect(within(getExecSubagentRow(view)).getByText("Exec")).toBeTruthy();
    expect(view.getByText("UI agents")).toBeTruthy();
    expect(view.getByText("Sub-agents")).toBeTruthy();
  });

  test("resetting a mirrored subagent model removes the stale mirrored entry", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        explore: { modelString: "anthropic:foo" },
      },
      subagentAiDefaults: {
        explore: { modelString: "anthropic:foo" },
      },
    });

    await view.findByText("Explore");
    fireEvent.click(
      within(getAgentCardByName(view, "Explore")).getByRole("button", { name: "Reset" })
    );

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore).toBeUndefined();
    expect(payload.subagentAiDefaults.explore).toBeUndefined();
  });

  test("unset Exec subagent defaults inherit from UI Exec", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "medium" },
      },
      subagentAiDefaults: {},
    });

    const row = await view.findByRole("group", { name: "Exec defaults" });

    expect(within(row).getByText("Inherits from UI Exec: anthropic:ui-exec")).toBeTruthy();
    expect(within(row).getByText("Inherits from UI Exec: medium")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Inherit from UI Exec" })).toBeNull();
  });

  test("clamps inherited Exec subagent thinking hint to the effective model policy", async () => {
    const model = "openai:gpt-5-pro";
    const expectedLabel = getThinkingOptionLabel(enforceThinkingPolicy(model, "xhigh"), model);
    const unclampedLabel = getThinkingOptionLabel("xhigh", model);

    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "xhigh" },
      },
      subagentAiDefaults: {
        exec: { modelString: model },
      },
    });

    const row = await view.findByRole("group", { name: "Exec defaults" });

    expect(within(row).getByText(`Inherits from UI Exec: ${expectedLabel}`)).toBeTruthy();
    if (unclampedLabel !== expectedLabel) {
      expect(within(row).queryByText(`Inherits from UI Exec: ${unclampedLabel}`)).toBeNull();
    }
    expect(within(row).queryByText("Inherits from UI Exec: Inherit")).toBeNull();
  });

  test("setting only the Exec subagent model writes only the sparse subagent model", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "medium" },
      },
      subagentAiDefaults: {},
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.change(within(row).getByLabelText("Model"), {
      target: { value: "openai:subagent-model" },
    });

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.subagentAiDefaults).toEqual({
      exec: { modelString: "openai:subagent-model" },
    });
    expect(payload.agentAiDefaults.exec).toEqual({
      modelString: "anthropic:ui-exec",
      thinkingLevel: "medium",
    });
    expect(payload.subagentAiDefaults.exec?.thinkingLevel).toBeUndefined();
  });

  test("setting only the Exec subagent thinking writes only the sparse subagent thinking", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "medium" },
      },
      subagentAiDefaults: {},
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.change(within(row).getByLabelText("Reasoning"), {
      target: { value: "high" },
    });

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.subagentAiDefaults).toEqual({
      exec: { thinkingLevel: "high" },
    });
    expect(payload.agentAiDefaults.exec).toEqual({
      modelString: "anthropic:ui-exec",
      thinkingLevel: "medium",
    });
    expect("modelString" in (payload.subagentAiDefaults.exec ?? {})).toBe(false);
  });

  test("resetting one Exec subagent field removes only that field", async () => {
    const view = renderTasksSection({
      subagentAiDefaults: {
        exec: { modelString: "openai:subagent-model", thinkingLevel: "high" },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.click(within(row).getAllByRole("button", { name: "Inherit from UI Exec" })[0]);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.subagentAiDefaults).toEqual({ exec: { thinkingLevel: "high" } });
  });

  test("resetting the last Exec subagent field removes the exec entry", async () => {
    const view = renderTasksSection({
      subagentAiDefaults: {
        exec: { modelString: "openai:subagent-model" },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.click(within(row).getByRole("button", { name: "Inherit from UI Exec" }));

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.subagentAiDefaults).toEqual({});
  });
});
