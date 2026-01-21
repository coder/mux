import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import {
  parseRuntimeString,
  prepareCompactionMessage,
  handlePlanShowCommand,
  handlePlanOpenCommand,
  handleCompactCommand,
  buildContinueMessage,
} from "./chatCommands";
import type { CommandHandlerContext } from "./chatCommands";
import type { ReviewNoteData } from "@/common/types/review";

// Simple mock for localStorage to satisfy resolveCompactionModel.
// Note: resolveCompactionModel reads from window.localStorage (via readPersistedString),
// so we set both globalThis.localStorage and window.localStorage for test isolation.
beforeEach(() => {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  } as unknown as Storage;

  globalThis.localStorage = storage;

  if (typeof window !== "undefined") {
    try {
      Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    } catch {
      // Some test DOM environments expose localStorage as a readonly getter.
      (window as unknown as { localStorage?: Storage }).localStorage = storage;
    }
  }
});

describe("parseRuntimeString", () => {
  const workspaceName = "test-workspace";

  test("returns undefined for undefined runtime (default to worktree)", () => {
    expect(parseRuntimeString(undefined, workspaceName)).toBeUndefined();
  });

  test("returns undefined for explicit 'worktree' runtime", () => {
    expect(parseRuntimeString("worktree", workspaceName)).toBeUndefined();
    expect(parseRuntimeString("WORKTREE", workspaceName)).toBeUndefined();
    expect(parseRuntimeString(" worktree ", workspaceName)).toBeUndefined();
  });

  test("returns local config for explicit 'local' runtime", () => {
    // "local" now returns project-dir runtime config (no srcBaseDir)
    expect(parseRuntimeString("local", workspaceName)).toEqual({ type: "local" });
    expect(parseRuntimeString("LOCAL", workspaceName)).toEqual({ type: "local" });
    expect(parseRuntimeString(" local ", workspaceName)).toEqual({ type: "local" });
  });

  test("parses valid SSH runtime", () => {
    const result = parseRuntimeString("ssh user@host", workspaceName);
    expect(result).toEqual({
      type: "ssh",
      host: "user@host",
      srcBaseDir: "~/mux",
    });
  });

  test("preserves case in SSH host", () => {
    const result = parseRuntimeString("ssh User@Host.Example.Com", workspaceName);
    expect(result).toEqual({
      type: "ssh",
      host: "User@Host.Example.Com",
      srcBaseDir: "~/mux",
    });
  });

  test("handles extra whitespace", () => {
    const result = parseRuntimeString("  ssh   user@host  ", workspaceName);
    expect(result).toEqual({
      type: "ssh",
      host: "user@host",
      srcBaseDir: "~/mux",
    });
  });

  test("throws error for SSH without host", () => {
    expect(() => parseRuntimeString("ssh", workspaceName)).toThrow("SSH runtime requires host");
    expect(() => parseRuntimeString("ssh ", workspaceName)).toThrow("SSH runtime requires host");
  });

  test("accepts SSH with hostname only (user will be inferred)", () => {
    const result = parseRuntimeString("ssh hostname", workspaceName);
    // Uses tilde path - backend will resolve it via runtime.resolvePath()
    expect(result).toEqual({
      type: "ssh",
      host: "hostname",
      srcBaseDir: "~/mux",
    });
  });

  test("accepts SSH with hostname.domain only", () => {
    const result = parseRuntimeString("ssh dev.example.com", workspaceName);
    // Uses tilde path - backend will resolve it via runtime.resolvePath()
    expect(result).toEqual({
      type: "ssh",
      host: "dev.example.com",
      srcBaseDir: "~/mux",
    });
  });

  test("uses tilde path for root user too", () => {
    const result = parseRuntimeString("ssh root@hostname", workspaceName);
    // Backend will resolve ~ to /root for root user
    expect(result).toEqual({
      type: "ssh",
      host: "root@hostname",
      srcBaseDir: "~/mux",
    });
  });

  test("parses docker runtime with image", () => {
    const result = parseRuntimeString("docker ubuntu:22.04", workspaceName);
    expect(result).toEqual({
      type: "docker",
      image: "ubuntu:22.04",
    });
  });

  test("parses docker with registry image", () => {
    const result = parseRuntimeString("docker ghcr.io/myorg/dev:latest", workspaceName);
    expect(result).toEqual({
      type: "docker",
      image: "ghcr.io/myorg/dev:latest",
    });
  });

  test("throws error for docker without image", () => {
    expect(() => parseRuntimeString("docker", workspaceName)).toThrow(
      "Docker runtime requires image"
    );
    expect(() => parseRuntimeString("docker ", workspaceName)).toThrow(
      "Docker runtime requires image"
    );
  });

  test("throws error for unknown runtime type", () => {
    expect(() => parseRuntimeString("remote", workspaceName)).toThrow(
      "Unknown runtime type: 'remote'. Use 'ssh <host>', 'docker <image>', 'worktree', or 'local'"
    );
    expect(() => parseRuntimeString("kubernetes", workspaceName)).toThrow(
      "Unknown runtime type: 'kubernetes'. Use 'ssh <host>', 'docker <image>', 'worktree', or 'local'"
    );
  });
});

describe("buildContinueMessage", () => {
  test("returns undefined when no content provided", () => {
    const result = buildContinueMessage({
      model: "anthropic:claude-3-5-sonnet",
      agentId: "exec",
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when text is empty string", () => {
    const result = buildContinueMessage({
      text: "",
      model: "anthropic:claude-3-5-sonnet",
      agentId: "exec",
    });
    expect(result).toBeUndefined();
  });

  test("returns message when text is provided", () => {
    const result = buildContinueMessage({
      text: "Continue with this",
      model: "anthropic:claude-3-5-sonnet",
      agentId: "exec",
    });
    expect(result).toBeDefined();
    expect(result?.text).toBe("Continue with this");
    expect(result?.model).toBe("anthropic:claude-3-5-sonnet");
    expect(result?.agentId).toBe("exec");
  });

  test("returns message when only images provided", () => {
    const result = buildContinueMessage({
      imageParts: [{ url: "data:image/png;base64,abc", mediaType: "image/png" }],
      model: "anthropic:claude-3-5-sonnet",
      agentId: "plan",
    });
    expect(result).toBeDefined();
    expect(result?.text).toBe("");
    expect(result?.imageParts).toHaveLength(1);
    expect(result?.agentId).toBe("plan");
  });

  test("returns message when only reviews provided", () => {
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/test.ts",
        lineRange: "10-15",
        selectedCode: "const x = 1;",
        userNote: "Fix this",
      },
    ];
    const result = buildContinueMessage({
      reviews,
      model: "anthropic:claude-3-5-sonnet",
      agentId: "exec",
    });
    expect(result).toBeDefined();
    expect(result?.text).toBe("");
    expect(result?.reviews).toHaveLength(1);
    expect(result?.reviews?.[0].userNote).toBe("Fix this");
  });

  test("includes all fields when all provided", () => {
    const reviews: ReviewNoteData[] = [
      { filePath: "src/a.ts", lineRange: "1", selectedCode: "x", userNote: "note" },
    ];
    const imageParts = [{ url: "data:image/png;base64,abc", mediaType: "image/png" }];

    const result = buildContinueMessage({
      text: "Check this",
      imageParts,
      reviews,
      model: "anthropic:claude-3-5-sonnet",
      agentId: "plan",
    });

    expect(result).toBeDefined();
    expect(result?.text).toBe("Check this");
    expect(result?.imageParts).toHaveLength(1);
    expect(result?.reviews).toHaveLength(1);
    expect(result?.model).toBe("anthropic:claude-3-5-sonnet");
    expect(result?.agentId).toBe("plan");
  });
});

describe("prepareCompactionMessage", () => {
  const createBaseOptions = (): SendMessageOptions => ({
    model: "anthropic:claude-3-5-sonnet",
    thinkingLevel: "medium",
    toolPolicy: [],
    agentId: "exec",
  });

  test("passes through continueMessage as-is (caller should use buildContinueMessage)", () => {
    const sendMessageOptions = createBaseOptions();
    const continueMessage = buildContinueMessage({
      text: "Keep building",
      model: sendMessageOptions.model,
      agentId: "exec",
    });

    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      continueMessage,
      model: "anthropic:claude-3-5-haiku",
      sendMessageOptions,
    });

    expect(metadata.type).toBe("compaction-request");
    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    // Model should be exactly what was passed in continueMessage
    expect(metadata.parsed.continueMessage?.model).toBe(sendMessageOptions.model);
    expect(metadata.parsed.continueMessage?.agentId).toBe("exec");
  });

  test("does not create continueMessage when no text or images provided", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      sendMessageOptions,
    });

    expect(metadata.type).toBe("compaction-request");
    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeUndefined();
  });

  test("creates continueMessage when text is provided", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: buildContinueMessage({
        text: "Continue with this",
        model: sendMessageOptions.model,
        agentId: "exec",
      }),
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeDefined();
    expect(metadata.parsed.continueMessage?.text).toBe("Continue with this");
  });

  test("rawCommand excludes multiline continue payload", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 2048,
      model: "anthropic:claude-3-5-haiku",
      continueMessage: buildContinueMessage({
        text: "Line 1\nLine 2",
        model: sendMessageOptions.model,
        agentId: "exec",
      }),
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.rawCommand).toBe("/compact -t 2048 -m anthropic:claude-3-5-haiku");
    expect(metadata.rawCommand).not.toContain("Line 1");
    expect(metadata.rawCommand).not.toContain("\n");
  });

  test("omits default resume text from compaction prompt", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText, metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: buildContinueMessage({
        text: "Continue",
        model: sendMessageOptions.model,
        agentId: "exec",
      }),
      sendMessageOptions,
    });

    expect(messageText).not.toContain("The user wants to continue with: Continue");

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    // Still queued for auto-send after compaction
    expect(metadata.parsed.continueMessage?.text).toBe("Continue");
  });

  test("includes non-default continue text in compaction prompt", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: buildContinueMessage({
        text: "fix tests",
        model: sendMessageOptions.model,
        agentId: "exec",
      }),
      sendMessageOptions,
    });

    expect(messageText).toContain("The user wants to continue with: fix tests");
  });

  test("creates continueMessage when images are provided without text", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: buildContinueMessage({
        imageParts: [{ url: "data:image/png;base64,abc", mediaType: "image/png" }],
        model: sendMessageOptions.model,
        agentId: "exec",
      }),
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeDefined();
    expect(metadata.parsed.continueMessage?.imageParts).toHaveLength(1);
  });

  test("creates continueMessage when reviews are provided without text", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: buildContinueMessage({
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10-15",
            selectedCode: "const x = 1;",
            userNote: "Please fix this",
          },
        ],
        model: sendMessageOptions.model,
        agentId: "exec",
      }),
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeDefined();
    expect(metadata.parsed.continueMessage?.reviews).toHaveLength(1);
    expect(metadata.parsed.continueMessage?.reviews?.[0].userNote).toBe("Please fix this");
  });

  test("creates continueMessage with reviews and text combined", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: buildContinueMessage({
        text: "Also check the tests",
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10-15",
            selectedCode: "const x = 1;",
            userNote: "Fix this bug",
          },
        ],
        model: sendMessageOptions.model,
        agentId: "exec",
      }),
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeDefined();
    expect(metadata.parsed.continueMessage?.text).toBe("Also check the tests");
    expect(metadata.parsed.continueMessage?.reviews).toHaveLength(1);
  });

  test("does not treat 'Continue' as default resume when reviews are present", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText, metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: buildContinueMessage({
        text: "Continue",
        reviews: [
          {
            filePath: "src/test.ts",
            lineRange: "10",
            selectedCode: "x = 1",
            userNote: "Check this",
          },
        ],
        model: sendMessageOptions.model,
        agentId: "exec",
      }),
      sendMessageOptions,
    });

    // When reviews are present, "Continue" should be included in compaction prompt
    // because there's actual work to continue with (the reviews)
    expect(messageText).toContain("The user wants to continue with: Continue");

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage?.reviews).toHaveLength(1);
  });
});

describe("handlePlanShowCommand", () => {
  const createMockContext = (
    getPlanContentResult:
      | { success: true; data: { content: string; path: string } }
      | { success: false; error: string }
  ): CommandHandlerContext => {
    const setInput = mock(() => undefined);
    const setToast = mock(() => undefined);

    return {
      workspaceId: "test-workspace-id",
      setInput,
      setToast,
      api: {
        workspace: {
          getPlanContent: mock(() => Promise.resolve(getPlanContentResult)),
        },
        general: {},
      } as unknown as CommandHandlerContext["api"],
      // Required fields for CommandHandlerContext
      sendMessageOptions: {
        model: "anthropic:claude-3-5-sonnet",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      },
      setImageAttachments: mock(() => undefined),
      setIsSending: mock(() => undefined),
    };
  };

  test("shows error toast when no plan exists", async () => {
    const context = createMockContext({ success: false, error: "No plan found" });

    const result = await handlePlanShowCommand(context);

    expect(result.clearInput).toBe(true);
    expect(result.toastShown).toBe(true);
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "No plan found for this workspace",
      })
    );
  });

  test("clears input when plan is found", async () => {
    const context = createMockContext({
      success: true,
      data: { content: "# My Plan\n\nStep 1", path: "/path/to/plan.md" },
    });

    const result = await handlePlanShowCommand(context);

    expect(result.clearInput).toBe(true);
    expect(result.toastShown).toBe(false);
    expect(context.setInput).toHaveBeenCalledWith("");
    expect(context.api.workspace.getPlanContent).toHaveBeenCalledWith({
      workspaceId: "test-workspace-id",
    });
  });
});

describe("handlePlanOpenCommand", () => {
  const createMockContext = (
    getPlanContentResult:
      | { success: true; data: { content: string; path: string } }
      | { success: false; error: string },
    openInEditorResult?: { success: true; data: undefined } | { success: false; error: string }
  ): CommandHandlerContext => {
    const setInput = mock(() => undefined);
    const setToast = mock(() => undefined);

    return {
      workspaceId: "test-workspace-id",
      setInput,
      setToast,
      api: {
        workspace: {
          getPlanContent: mock(() => Promise.resolve(getPlanContentResult)),
          getInfo: mock(() => Promise.resolve(null)),
        },
        general: {
          openInEditor: mock(() =>
            Promise.resolve(openInEditorResult ?? { success: true, data: undefined })
          ),
        },
      } as unknown as CommandHandlerContext["api"],
      // Required fields for CommandHandlerContext
      sendMessageOptions: {
        model: "anthropic:claude-3-5-sonnet",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      },
      setImageAttachments: mock(() => undefined),
      setIsSending: mock(() => undefined),
    };
  };

  test("shows error toast when no plan exists", async () => {
    const context = createMockContext({ success: false, error: "No plan found" });

    const result = await handlePlanOpenCommand(context);

    expect(result.clearInput).toBe(true);
    expect(result.toastShown).toBe(true);
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "No plan found for this workspace",
      })
    );
    expect(context.api.workspace.getInfo).not.toHaveBeenCalled();
    // Should not attempt to open editor
    expect(context.api.general.openInEditor).not.toHaveBeenCalled();
  });

  test("opens plan in editor when plan exists", async () => {
    const context = createMockContext(
      { success: true, data: { content: "# My Plan", path: "/path/to/plan.md" } },
      { success: true, data: undefined }
    );

    const result = await handlePlanOpenCommand(context);

    expect(result.clearInput).toBe(true);
    expect(context.setInput).toHaveBeenCalledWith("");
    expect(context.api.workspace.getPlanContent).toHaveBeenCalledWith({
      workspaceId: "test-workspace-id",
    });
    expect(context.api.workspace.getInfo).toHaveBeenCalledWith({
      workspaceId: "test-workspace-id",
    });
    // Note: Built-in editors (VS Code/Cursor/Zed) now use deep links directly
    // via window.open(), not the backend API. The backend API is only used
    // for custom editors.
  });

  // Note: The "editor fails to open" test was removed because built-in editors
  // (VS Code/Cursor/Zed) now use deep links that open via window.open() and
  // always succeed from the app's perspective. Failures happen in the external
  // editor, not in our code path.
});

describe("handleCompactCommand", () => {
  const createMockContext = (
    sendMessageResult: { success: true } | { success: false; error?: string },
    options?: { reviews?: ReviewNoteData[] }
  ): CommandHandlerContext => {
    const setInput = mock(() => undefined);
    const setToast = mock(() => undefined);
    const setImageAttachments = mock(() => undefined);
    const setIsSending = mock(() => undefined);

    // Track the options passed to sendMessage
    const sendMessageMock = mock(() => Promise.resolve(sendMessageResult));

    return {
      workspaceId: "test-workspace-id",
      setInput,
      setToast,
      setImageAttachments,
      setIsSending,
      reviews: options?.reviews,
      api: {
        workspace: {
          sendMessage: sendMessageMock,
        },
      } as unknown as CommandHandlerContext["api"],
      sendMessageOptions: {
        model: "anthropic:claude-3-5-sonnet",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      },
    };
  };

  test("passes reviews to continueMessage when reviews are attached", async () => {
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/test.ts",
        lineRange: "10-15",
        selectedCode: "const x = 1;",
        userNote: "Please fix this bug",
      },
    ];

    const context = createMockContext({ success: true }, { reviews });

    await handleCompactCommand({ type: "compact" }, context);

    // Verify sendMessage was called with reviews in the metadata
    const sendMessageMock = context.api.workspace.sendMessage as ReturnType<typeof mock>;
    expect(sendMessageMock).toHaveBeenCalled();

    const callArgs = sendMessageMock.mock.calls[0][0] as {
      options?: { muxMetadata?: { parsed?: { continueMessage?: { reviews?: ReviewNoteData[] } } } };
    };
    const continueMessage = callArgs?.options?.muxMetadata?.parsed?.continueMessage;

    expect(continueMessage).toBeDefined();
    expect(continueMessage?.reviews).toHaveLength(1);
    expect(continueMessage?.reviews?.[0].userNote).toBe("Please fix this bug");
  });

  test("creates continueMessage with only reviews (no text)", async () => {
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/test.ts",
        lineRange: "10",
        selectedCode: "x = 1",
        userNote: "Check this",
      },
    ];

    const context = createMockContext({ success: true }, { reviews });

    // No continueMessage text, just reviews
    await handleCompactCommand({ type: "compact" }, context);

    const sendMessageMock = context.api.workspace.sendMessage as ReturnType<typeof mock>;
    expect(sendMessageMock).toHaveBeenCalled();

    const callArgs = sendMessageMock.mock.calls[0][0] as {
      options?: { muxMetadata?: { parsed?: { continueMessage?: { reviews?: ReviewNoteData[] } } } };
    };
    const continueMessage = callArgs?.options?.muxMetadata?.parsed?.continueMessage;

    // Should have continueMessage even without text, because reviews are present
    expect(continueMessage).toBeDefined();
    expect(continueMessage?.reviews).toHaveLength(1);
  });
});
