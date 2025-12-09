import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import {
  parseRuntimeString,
  prepareCompactionMessage,
  handlePlanShowCommand,
  handlePlanOpenCommand,
} from "./chatCommands";
import type { CommandHandlerContext } from "./chatCommands";

// Simple mock for localStorage to satisfy resolveCompactionModel
beforeEach(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage;
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

  test("throws error for unknown runtime type", () => {
    expect(() => parseRuntimeString("docker", workspaceName)).toThrow(
      "Unknown runtime type: 'docker'. Use 'ssh <host>', 'worktree', or 'local'"
    );
    expect(() => parseRuntimeString("remote", workspaceName)).toThrow(
      "Unknown runtime type: 'remote'. Use 'ssh <host>', 'worktree', or 'local'"
    );
  });
});

describe("prepareCompactionMessage", () => {
  const createBaseOptions = (): SendMessageOptions => ({
    model: "anthropic:claude-3-5-sonnet",
    thinkingLevel: "medium",
    toolPolicy: [],
    mode: "exec",
  });

  test("embeds continue message model from base send options", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      continueMessage: { text: "Keep building" },
      model: "anthropic:claude-3-5-haiku",
      sendMessageOptions,
    });

    expect(metadata.type).toBe("compaction-request");
    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage?.model).toBe(sendMessageOptions.model);
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
      continueMessage: { text: "Continue with this" },
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeDefined();
    expect(metadata.parsed.continueMessage?.text).toBe("Continue with this");
  });

  test("creates continueMessage when images are provided without text", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: {
        text: "",
        imageParts: [{ url: "data:image/png;base64,abc", mediaType: "image/png" }],
      },
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeDefined();
    expect(metadata.parsed.continueMessage?.imageParts).toHaveLength(1);
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
        mode: "exec",
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
    openInEditorResult?:
      | { success: true; data: { openedInEmbeddedTerminal: boolean } }
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
        general: {
          openInEditor: mock(() =>
            Promise.resolve(
              openInEditorResult ?? { success: true, data: { openedInEmbeddedTerminal: false } }
            )
          ),
        },
      } as unknown as CommandHandlerContext["api"],
      // Required fields for CommandHandlerContext
      sendMessageOptions: {
        model: "anthropic:claude-3-5-sonnet",
        thinkingLevel: "off",
        toolPolicy: [],
        mode: "exec",
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
    // Should not attempt to open editor
    expect(context.api.general.openInEditor).not.toHaveBeenCalled();
  });

  test("opens plan in editor when plan exists", async () => {
    const context = createMockContext(
      { success: true, data: { content: "# My Plan", path: "/path/to/plan.md" } },
      { success: true, data: { openedInEmbeddedTerminal: false } }
    );

    const result = await handlePlanOpenCommand(context);

    expect(result.clearInput).toBe(true);
    expect(context.setInput).toHaveBeenCalledWith("");
    expect(context.api.workspace.getPlanContent).toHaveBeenCalledWith({
      workspaceId: "test-workspace-id",
    });
    expect(context.api.general.openInEditor).toHaveBeenCalledWith({
      filePath: "/path/to/plan.md",
      workspaceId: "test-workspace-id",
    });
  });

  test("shows error toast when editor fails to open", async () => {
    const context = createMockContext(
      { success: true, data: { content: "# My Plan", path: "/path/to/plan.md" } },
      { success: false, error: "No editor configured" }
    );

    const result = await handlePlanOpenCommand(context);

    expect(result.clearInput).toBe(true);
    expect(result.toastShown).toBe(true);
    expect(context.setToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "No editor configured",
      })
    );
  });
});
