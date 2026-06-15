import "../../../../tests/ui/dom";

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import type { APIClient, UseAPIResult } from "@/browser/contexts/API";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import type { ProjectConfig, ProjectWorkflowSchedule } from "@/common/types/project";
import type { WorkflowDefinitionDescriptor } from "@/common/types/workflow";

void mock.module("@/browser/components/Dialog/Dialog", () => ({
  Dialog: (props: { open: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  DialogContent: (props: { children: ReactNode; className?: string }) => (
    <div className={props.className}>{props.children}</div>
  ),
  DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  DialogTitle: (props: { children: ReactNode; className?: string }) => (
    <h2 className={props.className}>{props.children}</h2>
  ),
}));

import { ProjectAutomationsModal } from "./ProjectAutomationsModal";

type ConnectedUseAPIResult = Extract<UseAPIResult, { status: "connected" }>;

interface ProjectAutomationsTestAPI {
  workflows: {
    listDefinitions: (input: {
      projectPath: string;
      workspaceId?: string;
    }) => Promise<WorkflowDefinitionDescriptor[]>;
  };
  projects: {
    listBranches: (input: {
      projectPath: string;
    }) => Promise<{ branches: string[]; recommendedTrunk: string | null }>;
    workflowSchedules: {
      set: (input: {
        projectPath: string;
        schedule: Omit<ProjectWorkflowSchedule, "lastRunStartedAt"> & { id?: string };
      }) => Promise<
        { success: true; data: ProjectWorkflowSchedule } | { success: false; error: string }
      >;
      run: (input: { projectPath: string; scheduleId: string }) => Promise<
        | {
            success: true;
            data: { runId: string; status: "backgrounded" | "completed" | "failed" };
          }
        | { success: false; error: string }
      >;
      remove: (input: {
        projectPath: string;
        scheduleId: string;
      }) => Promise<{ success: true; data: void } | { success: false; error: string }>;
    };
  };
}

let cleanupDom: (() => void) | null = null;
let listDefinitionsMock: ReturnType<typeof mock>;
let listBranchesMock: ReturnType<typeof mock>;
let setProjectScheduleMock: ReturnType<typeof mock>;
let runProjectScheduleMock: ReturnType<typeof mock>;
let removeProjectScheduleMock: ReturnType<typeof mock>;
let refreshProjectsMock: ReturnType<typeof mock>;

function createConnectedUseAPIResult(api: ProjectAutomationsTestAPI): ConnectedUseAPIResult {
  return {
    api: api as unknown as APIClient,
    status: "connected",
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  };
}

function createWorkflowDefinition(): WorkflowDefinitionDescriptor {
  return {
    name: "triage-github-issues",
    description: "Scan untriaged GitHub issues.",
    scope: "project",
    executable: true,
    sourcePath: "/repo/.mux/workflows/triage-github-issues.js",
  };
}

function createProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    workspaces: [
      {
        path: "/repo/control",
        id: "ws-1",
        name: "control",
        title: "Control workspace",
        runtimeConfig: { type: "local", srcBaseDir: "/tmp/mux-src" },
      },
    ],
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function changeTextField(element: Element, value: string): void {
  const formElement = element as HTMLInputElement | HTMLTextAreaElement;
  const valueDescriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(formElement),
    "value"
  );
  act(() => {
    if (valueDescriptor?.set != null) {
      valueDescriptor.set.call(formElement, value);
    }
    const trackedElement = formElement as unknown as {
      _valueTracker?: { setValue: (trackedValue: string) => void };
    };
    trackedElement._valueTracker?.setValue("");
    fireEvent.input(formElement, { target: { value } });
    fireEvent.change(formElement, { target: { value } });
  });
}

function renderProjectAutomationsModal(projectConfig: ProjectConfig = createProjectConfig()) {
  return render(
    <ProjectAutomationsModal
      open={true}
      projectPath="/repo"
      projectName="Repo"
      projectConfig={projectConfig}
      onOpenChange={() => undefined}
    />
  );
}

describe("ProjectAutomationsModal", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    listDefinitionsMock = mock(() => Promise.resolve([createWorkflowDefinition()]));
    listBranchesMock = mock(() =>
      Promise.resolve({ branches: ["main"], recommendedTrunk: "main" })
    );
    setProjectScheduleMock = mock(
      (input: Parameters<ProjectAutomationsTestAPI["projects"]["workflowSchedules"]["set"]>[0]) => {
        const data: ProjectWorkflowSchedule = {
          ...input.schedule,
          id: input.schedule.id ?? "generated-schedule-id",
        };
        return Promise.resolve({ success: true as const, data });
      }
    );
    runProjectScheduleMock = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { runId: "wfr_manual_project_schedule", status: "backgrounded" as const },
      })
    );
    removeProjectScheduleMock = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    refreshProjectsMock = mock(() => Promise.resolve());

    const api: ProjectAutomationsTestAPI = {
      workflows: {
        listDefinitions: (input) =>
          listDefinitionsMock(input) as Promise<WorkflowDefinitionDescriptor[]>,
      },
      projects: {
        listBranches: (input) =>
          listBranchesMock(input) as Promise<{
            branches: string[];
            recommendedTrunk: string | null;
          }>,
        workflowSchedules: {
          set: setProjectScheduleMock,
          run: runProjectScheduleMock,
          remove: removeProjectScheduleMock,
        },
      },
    };
    spyOn(APIModule, "useAPI").mockImplementation(() => createConnectedUseAPIResult(api));
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
      () =>
        ({
          getProjectConfig: () => undefined,
          refreshProjects: refreshProjectsMock,
          userProjects: new Map(),
        }) as unknown as ReturnType<typeof ProjectContextModule.useProjectContext>
    );
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("creates a fresh-workspace project automation", async () => {
    const view = renderProjectAutomationsModal();

    fireEvent.click(view.getByRole("button", { name: "New automation" }));

    await waitFor(() => {
      expect((view.getByLabelText("Project automation workflow") as HTMLSelectElement).value).toBe(
        "triage-github-issues"
      );
    });
    changeTextField(view.getByLabelText("Project automation name"), "GitHub triage");
    changeTextField(view.getByLabelText("Project automation interval in minutes"), "360");
    changeTextField(view.getByLabelText("Project automation args"), '{"label":"needs-triage"}');

    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setProjectScheduleMock).toHaveBeenCalledWith({
        projectPath: "/repo",
        schedule: {
          title: "GitHub triage",
          enabled: true,
          workflowName: "triage-github-issues",
          intervalMs: 360 * 60_000,
          args: { label: "needs-triage" },
          target: { type: "new-workspace", trunkBranch: "main" },
        },
      });
    });
    expect(refreshProjectsMock).toHaveBeenCalled();
  });

  test("runs a project automation from the list", async () => {
    const view = renderProjectAutomationsModal(
      createProjectConfig({
        workflowSchedules: [
          {
            id: "automation-1",
            title: "Security Scan",
            enabled: true,
            workflowName: "triage-github-issues",
            intervalMs: 15 * 60_000,
            target: { type: "new-workspace", trunkBranch: "main" },
          },
        ],
      })
    );

    const runButton = view.getByRole("button", { name: "Run Security Scan now" });
    await waitFor(() => {
      expect((runButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(runProjectScheduleMock).toHaveBeenCalledWith({
        projectPath: "/repo",
        scheduleId: "automation-1",
      });
    });
    expect(refreshProjectsMock).toHaveBeenCalled();
  });

  test("only shows context mode for existing-workspace project automations", async () => {
    const view = renderProjectAutomationsModal();

    fireEvent.click(view.getByRole("button", { name: "New automation" }));

    await waitFor(() => {
      expect((view.getByLabelText("Project automation workflow") as HTMLSelectElement).value).toBe(
        "triage-github-issues"
      );
    });
    expect(view.queryByLabelText("Project automation context mode")).toBeNull();

    fireEvent.change(view.getByLabelText("Project automation run target"), {
      target: { value: "existing-workspace" },
    });

    const contextModeSelect = view.getByLabelText(
      "Project automation context mode"
    ) as HTMLSelectElement;
    fireEvent.change(contextModeSelect, { target: { value: "reset" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setProjectScheduleMock).toHaveBeenCalledWith({
        projectPath: "/repo",
        schedule: {
          enabled: true,
          workflowName: "triage-github-issues",
          intervalMs: 15 * 60_000,
          contextMode: "reset",
          target: { type: "existing-workspace", workspaceId: "ws-1" },
        },
      });
    });
  });

  test("loads workflow definitions through an owner workspace for sub-project automations", async () => {
    const subProjectPath = "/repo/packages/api";
    const parentConfig = createProjectConfig();
    const subProjectConfig = createProjectConfig({ parentProjectPath: "/repo", workspaces: [] });
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
      () =>
        ({
          getProjectConfig: (path: string) => (path === "/repo" ? parentConfig : undefined),
          refreshProjects: refreshProjectsMock,
          userProjects: new Map([
            ["/repo", parentConfig],
            [subProjectPath, subProjectConfig],
          ]),
        }) as unknown as ReturnType<typeof ProjectContextModule.useProjectContext>
    );

    render(
      <ProjectAutomationsModal
        open={true}
        projectPath={subProjectPath}
        projectName="API"
        projectConfig={subProjectConfig}
        onOpenChange={() => undefined}
      />
    );

    await waitFor(() => {
      expect(listDefinitionsMock).toHaveBeenCalledWith({
        projectPath: subProjectPath,
        workspaceId: "ws-1",
      });
    });
  });

  test("offers owner workspaces for sub-project automations", async () => {
    const subProjectPath = "/repo/packages/api";
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
      () =>
        ({
          getProjectConfig: (path: string) =>
            path === "/repo"
              ? createProjectConfig({
                  workspaces: [
                    {
                      path: "/repo/control",
                      id: "ws-1",
                      name: "control",
                      title: "Control workspace",
                      subProjectPath,
                    },
                  ],
                })
              : undefined,
          refreshProjects: refreshProjectsMock,
          userProjects: new Map(),
        }) as unknown as ReturnType<typeof ProjectContextModule.useProjectContext>
    );
    const view = render(
      <ProjectAutomationsModal
        open={true}
        projectPath={subProjectPath}
        projectName="API"
        projectConfig={createProjectConfig({ parentProjectPath: "/repo", workspaces: [] })}
        onOpenChange={() => undefined}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "New automation" }));
    await waitFor(() => {
      expect((view.getByLabelText("Project automation workflow") as HTMLSelectElement).value).toBe(
        "triage-github-issues"
      );
    });
    fireEvent.change(view.getByLabelText("Project automation run target"), {
      target: { value: "existing-workspace" },
    });

    const workspaceSelect = view.getByLabelText(
      "Project automation existing workspace"
    ) as HTMLSelectElement;
    expect(workspaceSelect.value).toBe("ws-1");
    expect(view.getByRole("option", { name: "Control workspace" })).toBeTruthy();
  });

  test("filters owner workspace targets claimed by parent automations", async () => {
    const subProjectPath = "/repo/packages/api";
    const parentConfig = createProjectConfig({
      workflowSchedules: [
        {
          id: "parent-automation",
          enabled: true,
          workflowName: "triage-github-issues",
          intervalMs: 15 * 60_000,
          target: { type: "existing-workspace", workspaceId: "ws-1" },
        },
      ],
    });
    const subProjectConfig = createProjectConfig({ parentProjectPath: "/repo", workspaces: [] });
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
      () =>
        ({
          getProjectConfig: (path: string) => (path === "/repo" ? parentConfig : undefined),
          refreshProjects: refreshProjectsMock,
          userProjects: new Map([
            ["/repo", parentConfig],
            [subProjectPath, subProjectConfig],
          ]),
        }) as unknown as ReturnType<typeof ProjectContextModule.useProjectContext>
    );
    const view = render(
      <ProjectAutomationsModal
        open={true}
        projectPath={subProjectPath}
        projectName="API"
        projectConfig={subProjectConfig}
        onOpenChange={() => undefined}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "New automation" }));
    await waitFor(() => {
      expect((view.getByLabelText("Project automation workflow") as HTMLSelectElement).value).toBe(
        "triage-github-issues"
      );
    });
    fireEvent.change(view.getByLabelText("Project automation run target"), {
      target: { value: "existing-workspace" },
    });

    expect(view.queryByRole("option", { name: "Control workspace" })).toBeNull();
  });

  test("does not offer an existing workspace that already has an automation", async () => {
    const view = renderProjectAutomationsModal(
      createProjectConfig({
        workspaces: [
          { path: "/repo/control", id: "ws-1", name: "control", title: "Control workspace" },
          { path: "/repo/review", id: "ws-2", name: "review", title: "Review workspace" },
        ],
        workflowSchedules: [
          {
            id: "automation-1",
            enabled: true,
            workflowName: "triage-github-issues",
            intervalMs: 15 * 60_000,
            target: { type: "existing-workspace", workspaceId: "ws-1" },
          },
        ],
      })
    );

    fireEvent.click(view.getByRole("button", { name: "New automation" }));
    await waitFor(() => {
      expect((view.getByLabelText("Project automation workflow") as HTMLSelectElement).value).toBe(
        "triage-github-issues"
      );
    });
    fireEvent.change(view.getByLabelText("Project automation run target"), {
      target: { value: "existing-workspace" },
    });

    const workspaceSelect = view.getByLabelText(
      "Project automation existing workspace"
    ) as HTMLSelectElement;
    expect(workspaceSelect.value).toBe("ws-2");
    expect(view.queryByRole("option", { name: "Control workspace" })).toBeNull();
    expect(view.getByRole("option", { name: "Review workspace" })).toBeTruthy();
  });

  test("does not offer an existing workspace that already has a workspace schedule", async () => {
    const view = renderProjectAutomationsModal(
      createProjectConfig({
        workspaces: [
          {
            path: "/repo/control",
            id: "ws-1",
            name: "control",
            title: "Control workspace",
            workflowSchedule: {
              enabled: true,
              workflowName: "triage-github-issues",
              intervalMs: 15 * 60_000,
            },
          },
          { path: "/repo/review", id: "ws-2", name: "review", title: "Review workspace" },
        ],
      })
    );

    fireEvent.click(view.getByRole("button", { name: "New automation" }));
    await waitFor(() => {
      expect((view.getByLabelText("Project automation workflow") as HTMLSelectElement).value).toBe(
        "triage-github-issues"
      );
    });
    fireEvent.change(view.getByLabelText("Project automation run target"), {
      target: { value: "existing-workspace" },
    });

    const workspaceSelect = view.getByLabelText(
      "Project automation existing workspace"
    ) as HTMLSelectElement;
    expect(workspaceSelect.value).toBe("ws-2");
    expect(view.queryByRole("option", { name: "Control workspace" })).toBeNull();
    expect(view.getByRole("option", { name: "Review workspace" })).toBeTruthy();
  });

  test("preserves new automation edits when branch discovery finishes", async () => {
    const branches = createDeferred<{ branches: string[]; recommendedTrunk: string | null }>();
    listBranchesMock = mock(() => branches.promise);
    const view = renderProjectAutomationsModal();

    fireEvent.click(view.getByRole("button", { name: "New automation" }));
    await waitFor(() => {
      expect((view.getByLabelText("Project automation workflow") as HTMLSelectElement).value).toBe(
        "triage-github-issues"
      );
    });

    changeTextField(view.getByLabelText("Project automation name"), "Typed title");
    changeTextField(view.getByLabelText("Project automation args"), '{"label":"typed"}');

    await act(async () => {
      branches.resolve({ branches: ["develop"], recommendedTrunk: "develop" });
      await branches.promise;
    });

    expect((view.getByLabelText("Project automation name") as HTMLInputElement).value).toBe(
      "Typed title"
    );
    expect((view.getByLabelText("Project automation args") as HTMLTextAreaElement).value).toBe(
      '{"label":"typed"}'
    );
    await waitFor(() => {
      expect(
        (view.getByLabelText("Project automation base branch") as HTMLInputElement).value
      ).toBe("develop");
    });
  });

  test("disables list controls for missing workflows", async () => {
    const view = renderProjectAutomationsModal(
      createProjectConfig({
        workflowSchedules: [
          {
            id: "automation-1",
            enabled: false,
            workflowName: "missing-workflow",
            intervalMs: 15 * 60_000,
            target: { type: "new-workspace", trunkBranch: "main" },
          },
        ],
      })
    );

    await waitFor(() => {
      expect(view.getByText("Workflow not found.")).toBeTruthy();
    });
    expect(
      (view.getByRole("button", { name: "Run missing-workflow now" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (view.getByRole("switch", { name: "Enable missing-workflow" }) as HTMLInputElement).disabled
    ).toBe(true);
  });

  test("associates project automation validation errors with fields", async () => {
    const view = renderProjectAutomationsModal();

    fireEvent.click(view.getByRole("button", { name: "New automation" }));
    await waitFor(() => {
      expect((view.getByLabelText("Project automation workflow") as HTMLSelectElement).value).toBe(
        "triage-github-issues"
      );
    });

    const intervalInput = view.getByLabelText(
      "Project automation interval in minutes"
    ) as HTMLInputElement;
    const argsInput = view.getByLabelText("Project automation args") as HTMLTextAreaElement;
    changeTextField(intervalInput, "0");
    changeTextField(argsInput, "[]");

    expect(view.getByRole("alert").textContent).toContain(
      "Schedule interval must be between 1 and 1440 minutes."
    );
    expect(intervalInput.getAttribute("aria-invalid")).toBe("true");
    expect(intervalInput.getAttribute("aria-describedby")).toContain(
      "project-automation-interval-error"
    );
    expect(argsInput.getAttribute("aria-invalid")).toBe("true");
    expect(argsInput.getAttribute("aria-describedby")).toContain("project-automation-args-error");
  });
});
