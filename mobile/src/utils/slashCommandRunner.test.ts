import { executeSlashCommand, parseRuntimeStringForMobile } from "./slashCommandRunner";
import type { SlashCommandRunnerContext } from "./slashCommandRunner";

function createMockApi(): SlashCommandRunnerContext["api"] {
  const noopSubscription = { close: jest.fn() };
  const api = {
    workspace: {
      list: jest.fn(),
      create: jest.fn().mockResolvedValue({ success: false, error: "not implemented" }),
      getInfo: jest.fn(),
      getHistory: jest.fn(),
      getFullReplay: jest.fn(),
      remove: jest.fn(),
      fork: jest.fn().mockResolvedValue({ success: false, error: "not implemented" }),
      rename: jest.fn(),
      interruptStream: jest.fn(),
      truncateHistory: jest.fn().mockResolvedValue({ success: true, data: undefined }),
      replaceChatHistory: jest.fn(),
      sendMessage: jest.fn().mockResolvedValue({ success: true, data: undefined }),
      executeBash: jest.fn(),
      subscribeChat: jest.fn().mockReturnValue(noopSubscription),
    },
    providers: {
      list: jest.fn().mockResolvedValue(["anthropic"]),
      setProviderConfig: jest.fn().mockResolvedValue({ success: true, data: undefined }),
    },
    projects: {
      list: jest.fn(),
      listBranches: jest.fn().mockResolvedValue({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: jest.fn(),
        update: jest.fn(),
      },
    },
  } satisfies SlashCommandRunnerContext["api"];
  return api;
}

function createContext(
  overrides: Partial<SlashCommandRunnerContext> = {}
): SlashCommandRunnerContext {
  const api = createMockApi();
  return {
    api,
    workspaceId: "ws-1",
    metadata: null,
    sendMessageOptions: {
      model: "anthropic:claude-sonnet-4-5",
      mode: "plan",
      thinkingLevel: "default",
    },
    editingMessageId: undefined,
    onClearTimeline: jest.fn(),
    onCancelEdit: jest.fn(),
    onNavigateToWorkspace: jest.fn(),
    onSelectModel: jest.fn(),
    showInfo: jest.fn(),
    showError: jest.fn(),
    ...overrides,
  };
}

describe("parseRuntimeStringForMobile", () => {
  it("returns undefined for local runtimes", () => {
    expect(parseRuntimeStringForMobile(undefined)).toBeUndefined();
    expect(parseRuntimeStringForMobile("local")).toBeUndefined();
  });

  it("parses ssh runtimes with host", () => {
    expect(parseRuntimeStringForMobile("ssh user@host")).toEqual({
      type: "ssh",
      host: "user@host",
      srcBaseDir: "~/mux",
    });
  });
});

describe("executeSlashCommand", () => {
  it("truncates history for /clear", async () => {
    const ctx = createContext();
    const handled = await executeSlashCommand({ type: "clear" }, ctx);
    expect(handled).toBe(true);
    expect(ctx.api.workspace.truncateHistory).toHaveBeenCalledWith("ws-1", 1);
    expect(ctx.onClearTimeline).toHaveBeenCalled();
  });

  it("shows unsupported info for telemetry commands", async () => {
    const ctx = createContext();
    const handled = await executeSlashCommand({ type: "telemetry-set", enabled: true }, ctx);
    expect(handled).toBe(true);
    expect(ctx.showInfo).toHaveBeenCalledWith(
      "Not supported",
      "This command is only available on the desktop app."
    );
  });
});
