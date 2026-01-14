import { describe, expect, test } from "bun:test";

import type { ProjectsConfig } from "@/common/types/project";
import { createIsolatedConfigForTestInstance } from "./testInstanceService";

describe("createIsolatedConfigForTestInstance", () => {
  test("clears workspace history but preserves project setup", () => {
    const source: ProjectsConfig = {
      projects: new Map([
        [
          "/repo/project-a",
          {
            workspaces: [{ path: "/repo/project-a/.mux/ws-1" }],
            sections: [{ id: "deadbeef", name: "Section A", nextId: null }],
            idleCompactionHours: 12,
          },
        ],
      ]),
      apiServerPort: 1234,
    };

    const isolated = createIsolatedConfigForTestInstance(source);

    expect(isolated.apiServerPort).toBeUndefined();
    expect(Array.from(isolated.projects.keys())).toEqual(["/repo/project-a"]);

    const isolatedProject = isolated.projects.get("/repo/project-a");
    expect(isolatedProject).toBeDefined();
    expect(isolatedProject!.workspaces).toEqual([]);
    expect(isolatedProject!.sections).toEqual([
      { id: "deadbeef", name: "Section A", nextId: null },
    ]);
    expect(isolatedProject!.idleCompactionHours).toBe(12);

    // Ensure source is not mutated.
    expect(source.projects.get("/repo/project-a")!.workspaces).toEqual([
      { path: "/repo/project-a/.mux/ws-1" },
    ]);
  });
});
