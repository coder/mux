import "../../../../tests/ui/dom";

import type { APIClient } from "@/browser/contexts/API";
import type { RecursivePartial } from "@/browser/testUtils";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";

let cleanupDom: (() => void) | null = null;
let currentClientMock: RecursivePartial<APIClient> = {};
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: currentClientMock as APIClient,
    status: "connected" as const,
    error: null,
  }),
  APIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { ProjectAddForm } from "../ProjectCreateModal/ProjectCreateModal";

describe("ProjectAddForm", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    currentClientMock = {};
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    currentClientMock = {};
  });

  test("normalizes pick-folder metadata before create", async () => {
    const createMock = mock(() =>
      Promise.resolve({
        success: true as const,
        data: {
          normalizedPath: "/tmp/demo",
          projectConfig: {
            workspaces: [],
            projectId: "proj_demo",
          },
        },
      })
    );

    currentClientMock = {
      projects: {
        list: () => Promise.resolve([]),
        create: createMock,
        getDefaultProjectDir: () => Promise.resolve("/tmp"),
      },
    };

    const onSuccess = mock(() => undefined);
    const { getByPlaceholderText, getByRole, getAllByLabelText, getByLabelText } = render(
      <ProjectAddForm isOpen onSuccess={onSuccess} />
    );

    const pathInput = getByPlaceholderText("/home/user/projects/my-project");
    const user = userEvent.setup({ document: pathInput.ownerDocument });

    await user.type(pathInput, "  /tmp/demo  ");
    await user.type(getByLabelText("Project name"), "   Demo Name   ");
    await user.type(getByLabelText("System prompt"), "   ");

    await user.click(getByRole("button", { name: "Add working directory" }));
    await user.type(getAllByLabelText("Extra working directory")[0], "   /tmp/demo/apps   ");

    await user.click(getByRole("button", { name: "Add working directory" }));
    await user.type(getAllByLabelText("Extra working directory")[1], "    ");

    await user.click(getByRole("button", { name: "Add Project" }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    expect(createMock).toHaveBeenCalledWith({
      projectPath: "/tmp/demo",
      name: "Demo Name",
      workingDirectories: [{ path: "/tmp/demo/apps" }],
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });
});
