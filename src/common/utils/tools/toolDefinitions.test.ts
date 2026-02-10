import { TaskToolArgsSchema, TOOL_DEFINITIONS } from "./toolDefinitions";

describe("TOOL_DEFINITIONS", () => {
  it("accepts custom subagent_type IDs (deprecated alias)", () => {
    const parsed = TaskToolArgsSchema.safeParse({
      subagent_type: "potato",
      prompt: "do the thing",
      title: "Test",
      run_in_background: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subagent_type).toBe("potato");
    }
  });

  it("accepts bash tool calls using command (alias for script)", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      command: "ls",
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.script).toBe("ls");
      expect("command" in parsed.data).toBe(false);
    }
  });

  it("prefers script when both script and command are provided", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      script: "echo hi",
      command: "ls",
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.script).toBe("echo hi");
    }
  });

  it("rejects bash tool calls missing both script and command", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(false);
  });

  const filePathAliasCases = [
    {
      toolName: "file_read",
      args: {
        offset: 1,
        limit: 10,
      },
    },
    {
      toolName: "file_edit_replace_string",
      args: {
        old_string: "before",
        new_string: "after",
      },
    },
    {
      toolName: "file_edit_replace_lines",
      args: {
        start_line: 1,
        end_line: 1,
        new_lines: ["line"],
      },
    },
    {
      toolName: "file_edit_insert",
      args: {
        insert_after: "marker",
        content: "text",
      },
    },
  ] as const;

  it.each(filePathAliasCases)(
    "accepts path alias for $toolName and normalizes to file_path",
    ({ toolName, args }) => {
      const parsed = TOOL_DEFINITIONS[toolName].schema.safeParse({
        ...args,
        path: "src/example.ts",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.file_path).toBe("src/example.ts");
        expect("path" in parsed.data).toBe(false);
      }
    }
  );

  it.each(filePathAliasCases)(
    "prefers canonical file_path over path for $toolName",
    ({ toolName, args }) => {
      const parsed = TOOL_DEFINITIONS[toolName].schema.safeParse({
        ...args,
        file_path: "src/canonical.ts",
        path: "src/legacy.ts",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.file_path).toBe("src/canonical.ts");
        expect("path" in parsed.data).toBe(false);
      }
    }
  );

  it.each(filePathAliasCases)(
    "rejects $toolName when file_path is present but invalid, even if path is provided",
    ({ toolName, args }) => {
      const parsed = TOOL_DEFINITIONS[toolName].schema.safeParse({
        ...args,
        file_path: 123,
        path: "src/fallback.ts",
      });

      expect(parsed.success).toBe(false);
    }
  );

  it.each(filePathAliasCases)(
    "rejects $toolName calls missing both file_path and path",
    ({ toolName, args }) => {
      const parsed = TOOL_DEFINITIONS[toolName].schema.safeParse(args);
      expect(parsed.success).toBe(false);
    }
  );

  it("asks for clarification via ask_user_question (instead of emitting open questions)", () => {
    expect(TOOL_DEFINITIONS.ask_user_question.description).toContain(
      "MUST be used when you need user clarification"
    );
    expect(TOOL_DEFINITIONS.ask_user_question.description).toContain(
      "Do not output a list of open questions"
    );
  });

  it("encourages compact task briefs when spawning sub-agents", () => {
    expect(TOOL_DEFINITIONS.task.description).toContain("compact task brief");
    expect(TOOL_DEFINITIONS.task.description).toContain("plan file");
  });

  it("accepts ask_user_question headers longer than 12 characters", () => {
    const parsed = TOOL_DEFINITIONS.ask_user_question.schema.safeParse({
      questions: [
        {
          question: "How should docs be formatted?",
          header: "Documentation",
          options: [
            { label: "Inline", description: "Explain in code comments" },
            { label: "Sections", description: "Separate markdown sections" },
          ],
          multiSelect: false,
        },
        {
          question: "Should we show error handling?",
          header: "Error Handling",
          options: [
            { label: "Minimal", description: "Let errors bubble" },
            { label: "Basic", description: "Catch common errors" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects task(kind=bash) tool calls (bash is a separate tool)", () => {
    const parsed = TOOL_DEFINITIONS.task.schema.safeParse({
      // Legacy shape; should not validate against the current task schema.
      kind: "bash",
      script: "ls",
      timeout_secs: 100000,
      run_in_background: false,
    });

    expect(parsed.success).toBe(false);
  });

  it("discourages repeating plan contents or plan file location after propose_plan", () => {
    expect(TOOL_DEFINITIONS.propose_plan.description).toContain("do not paste the plan contents");
    expect(TOOL_DEFINITIONS.propose_plan.description).toContain("plan file path");
  });
});
