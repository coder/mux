import { describe, test, expect } from "bun:test";
import type { Runtime } from "@/node/runtime/Runtime";
import { listScripts, getScriptPath } from "./discovery";
import * as path from "path";

// Mock runtime for testing
function createMockRuntime(responses: Map<string, { stdout: string; exitCode: number }>): Runtime {
  const runtime: Runtime = {
    exec: (command: string) => {
      // Check for exact match first
      let response = responses.get(command);

      // Fallback: check if any key is a substring of the command
      if (!response) {
        for (const [key, val] of responses.entries()) {
          if (command.includes(key)) {
            response = val;
            break;
          }
        }
      }

      response = response ?? { stdout: "", exitCode: 1 };

      return Promise.resolve({
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(response.stdout));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stdin: new WritableStream(),
        exitCode: Promise.resolve(response.exitCode),
        duration: Promise.resolve(0),
      });
    },
    readFile: () => {
      throw new Error("readFile not implemented in mock");
    },
    writeFile: () => {
      throw new Error("writeFile not implemented in mock");
    },
    stat: () => {
      throw new Error("stat not implemented in mock");
    },
    resolvePath: () => {
      throw new Error("resolvePath not implemented in mock");
    },
    normalizePath: () => {
      throw new Error("normalizePath not implemented in mock");
    },
    getWorkspacePath: () => {
      throw new Error("getWorkspacePath not implemented in mock");
    },
    createWorkspace: () => {
      throw new Error("createWorkspace not implemented in mock");
    },
    initWorkspace: () => {
      throw new Error("initWorkspace not implemented in mock");
    },
    forkWorkspace: () => {
      throw new Error("forkWorkspace not implemented in mock");
    },
    deleteWorkspace: () => {
      throw new Error("deleteWorkspace not implemented in mock");
    },
    renameWorkspace: () => {
      throw new Error("renameWorkspace not implemented in mock");
    },
  };
  return runtime;
}

describe("listScripts", () => {
  const separator = ":::MUX_SCRIPT_START:::";

  test("returns empty array when scripts directory doesn't exist", async () => {
    const runtime = createMockRuntime(
      new Map([
        [
          separator, // Match the unique separator in the command
          { stdout: "", exitCode: 1 },
        ],
      ])
    );

    const scripts = await listScripts(runtime, "/test/workspace/empty");
    expect(scripts).toEqual([]);
  });

  test("discovers scripts with descriptions", async () => {
    const output = [
      `${separator}deploy`,
      "IS_EXECUTABLE:1",
      "#!/bin/bash",
      "# Description: Deploy the application",
      "echo 'deploying...'",
      "",
      `${separator}test.sh`,
      "IS_EXECUTABLE:0",
      "#!/bin/bash",
      "# Run tests",
      "echo 'testing...'",
    ].join("\n");

    const runtime = createMockRuntime(new Map([[separator, { stdout: output, exitCode: 0 }]]));

    const scripts = await listScripts(runtime, "/test/workspace/desc");
    expect(scripts).toEqual([
      {
        name: "deploy",
        description: "Deploy the application",
        isExecutable: true,
      },
      {
        name: "test.sh",
        description: "Run tests",
        isExecutable: false,
      },
    ]);
  });

  test("handles scripts with @description annotation", async () => {
    const output = [
      `${separator}build`,
      "IS_EXECUTABLE:1",
      "#!/bin/bash",
      "# @description Build the project",
      "echo 'building...'",
    ].join("\n");

    const runtime = createMockRuntime(new Map([[separator, { stdout: output, exitCode: 0 }]]));

    const scripts = await listScripts(runtime, "/test/workspace/annotation");
    expect(scripts).toEqual([
      {
        name: "build",
        description: "Build the project",
        isExecutable: true,
      },
    ]);
  });

  test("handles descriptions with various case and indentation", async () => {
    const output = [
      `${separator}case-test`,
      "IS_EXECUTABLE:1",
      "#!/bin/bash",
      "# description: Lowercase description",
      "",
      `${separator}indent-test`,
      "IS_EXECUTABLE:1",
      "#!/bin/bash",
      "  # Description: Indented description",
    ].join("\n");

    const runtime = createMockRuntime(new Map([[separator, { stdout: output, exitCode: 0 }]]));

    const scripts = await listScripts(runtime, "/test/workspace/case");
    expect(scripts).toEqual([
      {
        name: "case-test",
        description: "Lowercase description",
        isExecutable: true,
      },
      {
        name: "indent-test",
        description: "Indented description",
        isExecutable: true,
      },
    ]);
  });

  test("handles tool-style descriptions with indentation", async () => {
    const output = [
      `${separator}tool-indent`,
      "IS_EXECUTABLE:1",
      "#!/bin/bash",
      "  # @description Indented tool description",
    ].join("\n");

    const runtime = createMockRuntime(new Map([[separator, { stdout: output, exitCode: 0 }]]));

    const scripts = await listScripts(runtime, "/test/workspace/tool");
    expect(scripts).toEqual([
      {
        name: "tool-indent",
        description: "Indented tool description",
        isExecutable: true,
      },
    ]);
  });

  test("handles scripts without descriptions", async () => {
    const output = [
      `${separator}script`,
      "IS_EXECUTABLE:1",
      "#!/bin/bash",
      "echo 'no description'",
    ].join("\n");

    const runtime = createMockRuntime(new Map([[separator, { stdout: output, exitCode: 0 }]]));

    const scripts = await listScripts(runtime, "/test/workspace/nodesc");
    expect(scripts).toEqual([
      {
        name: "script",
        description: undefined,
        isExecutable: true,
      },
    ]);
  });
});

describe("getScriptPath", () => {
  test("uses POSIX separators for POSIX workspace paths", () => {
    const workspacePath = "/home/user/workspace";
    const scriptName = "test.sh";
    // Explicitly check for forward slashes regardless of host OS
    const expected = "/home/user/workspace/.cmux/scripts/test.sh";
    expect(getScriptPath(workspacePath, scriptName)).toBe(expected);
  });

  test("uses host separators (default) for Windows workspace paths", () => {
    const workspacePath = "C:\\Users\\user\\workspace";
    const scriptName = "test.bat";
    // Should use path.join, which depends on the host OS running the test
    const expected = path.join(workspacePath, ".cmux", "scripts", scriptName);
    expect(getScriptPath(workspacePath, scriptName)).toBe(expected);
  });
});
