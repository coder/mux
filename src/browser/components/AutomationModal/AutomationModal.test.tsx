import "../../../../tests/ui/dom";

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import type { APIClient, UseAPIResult } from "@/browser/contexts/API";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import type { ProjectWorkflowSchedule } from "@/common/types/project";
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

import { AutomationModal } from "./AutomationModal";

type ConnectedUseAPIResult = Extract<UseAPIResult, { status: "connected" }>;
type ErrorUseAPIResult = Extract<UseAPIResult, { status: "error" }>;

interface AutomationTestAPI {
  workflows: {
    listDefinitions: (input: {
      workspaceId?: string;
      projectPath?: string;
    }) => Promise<WorkflowDefinitionDescriptor[]>;
  };
  projects: {
    workflowSchedules: {
      set: (input: {
        projectPath: string;
        schedule: Omit<ProjectWorkflowSchedule, "id" | "lastRunStartedAt"> & { id?: string };
      }) => Promise<
        { success: true; data: ProjectWorkflowSchedule } | { success: false; error: string }
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
let setProjectWorkflowScheduleMock: ReturnType<typeof mock>;
let removeProjectWorkflowScheduleMock: ReturnType<typeof mock>;
let refreshProjectsMock: ReturnType<typeof mock>;

function createConnectedUseAPIResult(api: AutomationTestAPI): ConnectedUseAPIResult {
  return {
    api: api as unknown as APIClient,
    status: "connected",
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  };
}

function createErrorUseAPIResult(): ErrorUseAPIResult {
  return {
    api: null,
    status: "error",
    error: "API unavailable",
    authenticate: () => undefined,
    retry: () => undefined,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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

function createWorkflowDefinition(
  overrides: Partial<WorkflowDefinitionDescriptor> = {}
): WorkflowDefinitionDescriptor {
  return {
    name: "triage-issues",
    description: "Scan GitHub issues and create triage workspaces.",
    scope: "project",
    executable: true,
    sourcePath: "/repo/.mux/workflows/triage-issues.js",
    ...overrides,
  };
}

function createProjectWorkflowSchedule(
  overrides: Partial<ProjectWorkflowSchedule> = {}
): ProjectWorkflowSchedule {
  return {
    id: "automation-1",
    enabled: true,
    workflowName: "triage-issues",
    intervalMs: 15 * 60_000,
    target: { type: "existing-workspace", workspaceId: "ws-1" },
    ...overrides,
  };
}

function renderAutomationModal(
  overrides: Partial<React.ComponentProps<typeof AutomationModal>> = {}
) {
  return render(
    <AutomationModal
      open={true}
      projectPath="/repo"
      workspaceId="ws-1"
      workspaceName="Triage control"
      onOpenChange={() => undefined}
      {...overrides}
    />
  );
}

describe("AutomationModal", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    listDefinitionsMock = mock(() => Promise.resolve([createWorkflowDefinition()]));
    setProjectWorkflowScheduleMock = mock(() =>
      Promise.resolve({ success: true as const, data: createProjectWorkflowSchedule() })
    );
    removeProjectWorkflowScheduleMock = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    refreshProjectsMock = mock(() => Promise.resolve());
    const api: AutomationTestAPI = {
      workflows: {
        listDefinitions: listDefinitionsMock as AutomationTestAPI["workflows"]["listDefinitions"],
      },
      projects: {
        workflowSchedules: {
          set: setProjectWorkflowScheduleMock as AutomationTestAPI["projects"]["workflowSchedules"]["set"],
          remove:
            removeProjectWorkflowScheduleMock as AutomationTestAPI["projects"]["workflowSchedules"]["remove"],
        },
      },
    };
    spyOn(APIModule, "useAPI").mockImplementation(() => createConnectedUseAPIResult(api));
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
      () =>
        ({
          getProjectConfig: () => undefined,
          refreshProjects: refreshProjectsMock,
        }) as unknown as ReturnType<typeof ProjectContextModule.useProjectContext>
    );
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("preserves edits made before workflow definitions finish loading", async () => {
    const definitions = createDeferred<WorkflowDefinitionDescriptor[]>();
    listDefinitionsMock = mock(() => definitions.promise);
    const view = renderAutomationModal();

    fireEvent.click(view.getByRole("switch", { name: "Enable automation" }));
    changeTextField(view.getByLabelText("Automation interval in minutes"), "45");
    changeTextField(view.getByLabelText("Automation args"), '{"label":"triage"}');

    await act(async () => {
      definitions.resolve([createWorkflowDefinition()]);
      await definitions.promise;
    });

    await waitFor(() => {
      expect((view.getByLabelText("Automation workflow") as HTMLSelectElement).value).toBe(
        "triage-issues"
      );
    });
    expect((view.getByLabelText("Automation interval in minutes") as HTMLInputElement).value).toBe(
      "45"
    );
    expect((view.getByLabelText("Automation args") as HTMLTextAreaElement).value).toBe(
      '{"label":"triage"}'
    );
  });

  test("shows a loading option while workflow definitions are pending", () => {
    listDefinitionsMock = mock(() => new Promise<WorkflowDefinitionDescriptor[]>(() => undefined));
    const view = renderAutomationModal();

    expect(view.getByRole("option", { name: "Loading workflows…" })).toBeTruthy();
    expect(view.queryByText("No executable workflows found")).toBeNull();
  });

  test("loads workflow definitions by project path for sub-project schedules", async () => {
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
      () =>
        ({
          getProjectConfig: () => ({ parentProjectPath: "/repo", workspaces: [] }),
          refreshProjects: refreshProjectsMock,
        }) as unknown as ReturnType<typeof ProjectContextModule.useProjectContext>
    );
    renderAutomationModal({ projectPath: "/repo/packages/api" });

    await waitFor(() => {
      expect(listDefinitionsMock).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        projectPath: "/repo/packages/api",
      });
    });
  });

  test("saves an enabled project workflow schedule for this workspace", async () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    const view = renderAutomationModal({ onOpenChange });

    await waitFor(() => {
      expect((view.getByLabelText("Automation workflow") as HTMLSelectElement).value).toBe(
        "triage-issues"
      );
    });

    fireEvent.click(view.getByRole("switch", { name: "Enable automation" }));
    changeTextField(view.getByLabelText("Automation interval in minutes"), "30");
    changeTextField(view.getByLabelText("Automation args"), '{"label":"needs-triage"}');
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setProjectWorkflowScheduleMock).toHaveBeenCalledWith({
        projectPath: "/repo",
        schedule: {
          enabled: true,
          workflowName: "triage-issues",
          intervalMs: 30 * 60_000,
          args: { label: "needs-triage" },
          target: { type: "existing-workspace", workspaceId: "ws-1" },
        },
      });
    });
    expect(refreshProjectsMock).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("saves context mode for the workspace target", async () => {
    const view = renderAutomationModal();

    await waitFor(() => {
      expect((view.getByLabelText("Automation workflow") as HTMLSelectElement).value).toBe(
        "triage-issues"
      );
    });

    fireEvent.change(view.getByLabelText("Automation context mode"), {
      target: { value: "compact" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setProjectWorkflowScheduleMock).toHaveBeenCalledWith({
        projectPath: "/repo",
        schedule: {
          enabled: false,
          workflowName: "triage-issues",
          intervalMs: 15 * 60_000,
          contextMode: "compact",
          target: { type: "existing-workspace", workspaceId: "ws-1" },
        },
      });
    });
    expect(view.queryByLabelText("Automation run target")).toBeNull();
  });

  test("loads and updates the project automation targeting this workspace", async () => {
    listDefinitionsMock.mockImplementation(() =>
      Promise.resolve([
        createWorkflowDefinition(),
        createWorkflowDefinition({
          name: "daily-maintenance",
          description: "Run maintenance checks.",
        }),
      ])
    );
    const view = renderAutomationModal({
      projectWorkflowSchedule: createProjectWorkflowSchedule({
        id: "workspace-schedule",
        title: "Named automation",
        enabled: true,
        workflowName: "daily-maintenance",
        intervalMs: 60 * 60_000,
        args: { cadence: "hourly" },
      }),
    });

    await waitFor(() => {
      expect((view.getByLabelText("Automation workflow") as HTMLSelectElement).value).toBe(
        "daily-maintenance"
      );
    });
    expect((view.getByLabelText("Automation interval in minutes") as HTMLInputElement).value).toBe(
      "60"
    );
    expect((view.getByLabelText("Automation args") as HTMLTextAreaElement).value).toBe(
      JSON.stringify({ cadence: "hourly" }, null, 2)
    );

    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setProjectWorkflowScheduleMock).toHaveBeenCalledWith({
        projectPath: "/repo",
        schedule: {
          id: "workspace-schedule",
          title: "Named automation",
          enabled: true,
          workflowName: "daily-maintenance",
          intervalMs: 60 * 60_000,
          args: { cadence: "hourly" },
          target: { type: "existing-workspace", workspaceId: "ws-1" },
        },
      });
    });
  });

  test("shows persisted non-executable workflow selections", async () => {
    listDefinitionsMock.mockImplementation(() =>
      Promise.resolve([
        createWorkflowDefinition({
          name: "blocked-workflow",
          executable: false,
          blockedReason: "project is untrusted",
        }),
        createWorkflowDefinition(),
      ])
    );
    const view = renderAutomationModal({
      projectWorkflowSchedule: createProjectWorkflowSchedule({
        enabled: true,
        workflowName: "blocked-workflow",
        intervalMs: 15 * 60_000,
      }),
    });

    await waitFor(() => {
      expect(
        view.getByRole("option", { name: "blocked-workflow (project is untrusted)" })
      ).toBeTruthy();
    });
    expect((view.getByLabelText("Automation workflow") as HTMLSelectElement).value).toBe(
      "blocked-workflow"
    );
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("blocks saving when args are not a JSON object", async () => {
    const view = renderAutomationModal();

    await waitFor(() => {
      expect((view.getByLabelText("Automation workflow") as HTMLSelectElement).value).toBe(
        "triage-issues"
      );
    });

    changeTextField(view.getByLabelText("Automation args"), "[]");

    expect(view.getByText("Workflow args must be a JSON object.")).toBeTruthy();
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("removes the project automation targeting this workspace", async () => {
    const view = renderAutomationModal({
      projectWorkflowSchedule: createProjectWorkflowSchedule({ id: "workspace-schedule" }),
    });

    fireEvent.click(view.getByRole("button", { name: "Remove automation" }));

    await waitFor(() => {
      expect(removeProjectWorkflowScheduleMock).toHaveBeenCalledWith({
        projectPath: "/repo",
        scheduleId: "workspace-schedule",
      });
    });
    expect(refreshProjectsMock).toHaveBeenCalled();
  });

  test("disables remove when the API client is unavailable", () => {
    spyOn(APIModule, "useAPI").mockImplementation(() => createErrorUseAPIResult());
    const view = renderAutomationModal({
      projectWorkflowSchedule: createProjectWorkflowSchedule({
        enabled: false,
        workflowName: "triage-issues",
        intervalMs: 15 * 60_000,
      }),
    });

    expect(
      (view.getByRole("button", { name: "Remove automation" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  test("announces and associates interval and args validation errors", async () => {
    const view = renderAutomationModal();

    await waitFor(() => {
      expect((view.getByLabelText("Automation workflow") as HTMLSelectElement).value).toBe(
        "triage-issues"
      );
    });

    const intervalInput = view.getByLabelText("Automation interval in minutes") as HTMLInputElement;
    const argsInput = view.getByLabelText("Automation args") as HTMLTextAreaElement;
    changeTextField(intervalInput, "0");
    changeTextField(argsInput, "[]");

    const alert = view.getByRole("alert");
    expect(alert.textContent).toContain("Schedule interval must be between 1 and 1440 minutes.");
    expect(alert.textContent).toContain("Workflow args must be a JSON object.");
    expect(intervalInput.getAttribute("aria-invalid")).toBe("true");
    expect(intervalInput.getAttribute("aria-describedby")).toContain("automation-interval-error");
    expect(argsInput.getAttribute("aria-invalid")).toBe("true");
    expect(argsInput.getAttribute("aria-describedby")).toContain("automation-args-error");
  });
});
