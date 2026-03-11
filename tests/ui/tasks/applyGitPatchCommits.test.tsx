import "../dom";

import React from "react";
import { render } from "@testing-library/react";

import {
  TaskApplyGitPatchProjectResultCard,
  type ParsedProjectResult,
} from "@/browser/features/Tools/TaskApplyGitPatchToolCall";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";

const projectResults: ParsedProjectResult[] = [
  {
    projectPath: "/tmp/project-a",
    projectName: "project-a",
    status: "applied",
    appliedCommits: [
      {
        sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
        subject: "feat: add Apply Patch tool UI",
      },
    ],
  },
  {
    projectPath: "/tmp/project-b",
    projectName: "project-b",
    status: "skipped",
    error: "Patch generation was skipped because this project produced no commits.",
  },
  {
    projectPath: "/tmp/project-c",
    projectName: "project-c",
    status: "failed",
    error: "git am failed",
    failedPatchSubject: "fix: reconcile project-c changes",
    conflictPaths: ["src/index.ts"],
  },
];

describe("task_apply_git_patch commit list", () => {
  test("renders commit groups per project with skipped and failed sections", () => {
    const view = render(
      <TooltipProvider>
        <div>
          {projectResults.map((projectResult) => (
            <TaskApplyGitPatchProjectResultCard
              key={projectResult.projectPath}
              projectResult={projectResult}
              isDryRun={false}
            />
          ))}
        </div>
      </TooltipProvider>
    );

    expect(view.getByText("project-a")).toBeTruthy();
    expect(view.getByText("project-b")).toBeTruthy();
    expect(view.getByText("project-c")).toBeTruthy();
    expect(view.getByText("feat: add Apply Patch tool UI")).toBeTruthy();
    expect(
      view.getByText("Patch generation was skipped because this project produced no commits.")
    ).toBeTruthy();
    expect(view.getByText("fix: reconcile project-c changes")).toBeTruthy();
    expect(view.getByText("src/index.ts")).toBeTruthy();
    expect(view.getByText("0f1e2d3")).toBeTruthy();
  });
});
