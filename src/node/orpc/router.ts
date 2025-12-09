import { spawn } from "child_process";
import { os } from "@orpc/server";
import * as schemas from "@/common/orpc/schemas";
import type { ORPCContext } from "./context";
import {
  getPreferredNameModel,
  generateWorkspaceName,
} from "@/node/services/workspaceTitleGenerator";
import type {
  UpdateStatus,
  WorkspaceActivitySnapshot,
  WorkspaceChatMessage,
  FrontendWorkspaceMetadataSchemaType,
} from "@/common/orpc/types";
import { createAuthMiddleware } from "./authMiddleware";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { getPlanFilePath, readPlanFile } from "@/common/utils/planStorage";
import { findAvailableCommand, GUI_EDITORS, TERMINAL_EDITORS } from "@/node/utils/commandDiscovery";

export const router = (authToken?: string) => {
  const t = os.$context<ORPCContext>().use(createAuthMiddleware(authToken));

  return t.router({
    tokenizer: {
      countTokens: t
        .input(schemas.tokenizer.countTokens.input)
        .output(schemas.tokenizer.countTokens.output)
        .handler(async ({ context, input }) => {
          return context.tokenizerService.countTokens(input.model, input.text);
        }),
      countTokensBatch: t
        .input(schemas.tokenizer.countTokensBatch.input)
        .output(schemas.tokenizer.countTokensBatch.output)
        .handler(async ({ context, input }) => {
          return context.tokenizerService.countTokensBatch(input.model, input.texts);
        }),
      calculateStats: t
        .input(schemas.tokenizer.calculateStats.input)
        .output(schemas.tokenizer.calculateStats.output)
        .handler(async ({ context, input }) => {
          return context.tokenizerService.calculateStats(input.messages, input.model);
        }),
    },
    server: {
      getLaunchProject: t
        .input(schemas.server.getLaunchProject.input)
        .output(schemas.server.getLaunchProject.output)
        .handler(async ({ context }) => {
          return context.serverService.getLaunchProject();
        }),
    },
    providers: {
      list: t
        .input(schemas.providers.list.input)
        .output(schemas.providers.list.output)
        .handler(({ context }) => context.providerService.list()),
      getConfig: t
        .input(schemas.providers.getConfig.input)
        .output(schemas.providers.getConfig.output)
        .handler(({ context }) => context.providerService.getConfig()),
      setProviderConfig: t
        .input(schemas.providers.setProviderConfig.input)
        .output(schemas.providers.setProviderConfig.output)
        .handler(({ context, input }) =>
          context.providerService.setConfig(input.provider, input.keyPath, input.value)
        ),
      setModels: t
        .input(schemas.providers.setModels.input)
        .output(schemas.providers.setModels.output)
        .handler(({ context, input }) =>
          context.providerService.setModels(input.provider, input.models)
        ),
      onConfigChanged: t
        .input(schemas.providers.onConfigChanged.input)
        .output(schemas.providers.onConfigChanged.output)
        .handler(async function* ({ context }) {
          let resolveNext: (() => void) | null = null;
          let ended = false;

          const push = () => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            }
          };

          const unsubscribe = context.providerService.onConfigChanged(push);

          try {
            while (!ended) {
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });
              yield undefined;
            }
          } finally {
            ended = true;
            unsubscribe();
          }
        }),
    },
    general: {
      listDirectory: t
        .input(schemas.general.listDirectory.input)
        .output(schemas.general.listDirectory.output)
        .handler(async ({ context, input }) => {
          return context.projectService.listDirectory(input.path);
        }),
      ping: t
        .input(schemas.general.ping.input)
        .output(schemas.general.ping.output)
        .handler(({ input }) => {
          return `Pong: ${input}`;
        }),
      tick: t
        .input(schemas.general.tick.input)
        .output(schemas.general.tick.output)
        .handler(async function* ({ input }) {
          for (let i = 1; i <= input.count; i++) {
            yield { tick: i, timestamp: Date.now() };
            if (i < input.count) {
              await new Promise((r) => setTimeout(r, input.intervalMs));
            }
          }
        }),
      openInEditor: t
        .input(schemas.general.openInEditor.input)
        .output(schemas.general.openInEditor.output)
        .handler(async ({ context, input }) => {
          try {
            const visual = process.env.VISUAL;
            const editor = process.env.EDITOR;
            const isDesktop = context.terminalService.isDesktopMode();

            if (visual) {
              // $VISUAL is set - GUI editor, spawn directly (works in both modes)
              const child = spawn(visual, [input.filePath], {
                detached: true,
                stdio: "ignore",
              });
              child.unref();
              return { success: true as const, data: { openedInEmbeddedTerminal: false } };
            }

            if (editor) {
              // $EDITOR is set - terminal editor
              if (isDesktop) {
                // Desktop mode: open native terminal
                await context.terminalService.openNativeWithCommand(
                  `${editor} "${input.filePath}"`
                );
                return { success: true as const, data: { openedInEmbeddedTerminal: false } };
              } else {
                // Server mode: create embedded terminal with the command
                if (!input.workspaceId) {
                  return {
                    success: false as const,
                    error: "workspaceId required for opening editor in server mode",
                  };
                }
                const session = await context.terminalService.create({
                  workspaceId: input.workspaceId,
                  cols: 120,
                  rows: 30,
                  initialCommand: `${editor} "${input.filePath}"`,
                });
                return {
                  success: true as const,
                  data: {
                    openedInEmbeddedTerminal: true,
                    workspaceId: input.workspaceId,
                    sessionId: session.sessionId,
                  },
                };
              }
            }

            // Fallback: discover available GUI editors
            const guiEditor = await findAvailableCommand([...GUI_EDITORS]);
            if (guiEditor) {
              const child = spawn(guiEditor, [input.filePath], {
                detached: true,
                stdio: "ignore",
              });
              child.unref();
              return { success: true as const, data: { openedInEmbeddedTerminal: false } };
            }

            // Fallback: discover available terminal editors
            const terminalEditor = await findAvailableCommand([...TERMINAL_EDITORS]);
            if (terminalEditor) {
              if (isDesktop) {
                // Desktop mode: open native terminal with editor
                await context.terminalService.openNativeWithCommand(
                  `${terminalEditor} "${input.filePath}"`
                );
                return { success: true as const, data: { openedInEmbeddedTerminal: false } };
              } else {
                // Server mode: create embedded terminal with editor
                if (!input.workspaceId) {
                  return {
                    success: false as const,
                    error: "workspaceId required for opening editor in server mode",
                  };
                }
                const session = await context.terminalService.create({
                  workspaceId: input.workspaceId,
                  cols: 120,
                  rows: 30,
                  initialCommand: `${terminalEditor} "${input.filePath}"`,
                });
                return {
                  success: true as const,
                  data: {
                    openedInEmbeddedTerminal: true,
                    workspaceId: input.workspaceId,
                    sessionId: session.sessionId,
                  },
                };
              }
            }

            return { success: false as const, error: "No editor available" };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false as const, error: `Failed to open editor: ${message}` };
          }
        }),
      canOpenInEditor: t
        .input(schemas.general.canOpenInEditor.input)
        .output(schemas.general.canOpenInEditor.output)
        .handler(async () => {
          // Check $VISUAL first
          const visual = process.env.VISUAL;
          if (visual) {
            return { method: "visual" as const, editor: visual };
          }

          // Check $EDITOR
          const editor = process.env.EDITOR;
          if (editor) {
            return { method: "editor" as const, editor };
          }

          // Discover GUI editors
          const guiEditor = await findAvailableCommand([...GUI_EDITORS]);
          if (guiEditor) {
            return { method: "gui-fallback" as const, editor: guiEditor };
          }

          // Discover terminal editors
          const terminalEditor = await findAvailableCommand([...TERMINAL_EDITORS]);
          if (terminalEditor) {
            return {
              method: "terminal-fallback" as const,
              editor: terminalEditor,
              requiresTerminal: true,
            };
          }

          return { method: "none" as const };
        }),
    },
    projects: {
      list: t
        .input(schemas.projects.list.input)
        .output(schemas.projects.list.output)
        .handler(({ context }) => {
          return context.projectService.list();
        }),
      create: t
        .input(schemas.projects.create.input)
        .output(schemas.projects.create.output)
        .handler(async ({ context, input }) => {
          return context.projectService.create(input.projectPath);
        }),
      pickDirectory: t
        .input(schemas.projects.pickDirectory.input)
        .output(schemas.projects.pickDirectory.output)
        .handler(async ({ context }) => {
          return context.projectService.pickDirectory();
        }),
      listBranches: t
        .input(schemas.projects.listBranches.input)
        .output(schemas.projects.listBranches.output)
        .handler(async ({ context, input }) => {
          return context.projectService.listBranches(input.projectPath);
        }),
      remove: t
        .input(schemas.projects.remove.input)
        .output(schemas.projects.remove.output)
        .handler(async ({ context, input }) => {
          return context.projectService.remove(input.projectPath);
        }),
      secrets: {
        get: t
          .input(schemas.projects.secrets.get.input)
          .output(schemas.projects.secrets.get.output)
          .handler(({ context, input }) => {
            return context.projectService.getSecrets(input.projectPath);
          }),
        update: t
          .input(schemas.projects.secrets.update.input)
          .output(schemas.projects.secrets.update.output)
          .handler(async ({ context, input }) => {
            return context.projectService.updateSecrets(input.projectPath, input.secrets);
          }),
      },
      mcp: {
        list: t
          .input(schemas.projects.mcp.list.input)
          .output(schemas.projects.mcp.list.output)
          .handler(({ context, input }) => context.mcpConfigService.listServers(input.projectPath)),
        add: t
          .input(schemas.projects.mcp.add.input)
          .output(schemas.projects.mcp.add.output)
          .handler(({ context, input }) =>
            context.mcpConfigService.addServer(input.projectPath, input.name, input.command)
          ),
        remove: t
          .input(schemas.projects.mcp.remove.input)
          .output(schemas.projects.mcp.remove.output)
          .handler(({ context, input }) =>
            context.mcpConfigService.removeServer(input.projectPath, input.name)
          ),
        test: t
          .input(schemas.projects.mcp.test.input)
          .output(schemas.projects.mcp.test.output)
          .handler(({ context, input }) =>
            context.mcpServerManager.test(input.projectPath, input.name, input.command)
          ),
      },
    },
    nameGeneration: {
      generate: t
        .input(schemas.nameGeneration.generate.input)
        .output(schemas.nameGeneration.generate.output)
        .handler(async ({ context, input }) => {
          // Prefer small/fast models, fall back to user's configured model
          const model = (await getPreferredNameModel(context.aiService)) ?? input.fallbackModel;
          if (!model) {
            return {
              success: false,
              error: {
                type: "unknown" as const,
                raw: "No model available for name generation.",
              },
            };
          }
          const result = await generateWorkspaceName(input.message, model, context.aiService);
          if (!result.success) {
            return result;
          }
          return { success: true, data: { name: result.data, modelUsed: model } };
        }),
    },
    workspace: {
      list: t
        .input(schemas.workspace.list.input)
        .output(schemas.workspace.list.output)
        .handler(({ context }) => {
          return context.workspaceService.list();
        }),
      create: t
        .input(schemas.workspace.create.input)
        .output(schemas.workspace.create.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.create(
            input.projectPath,
            input.branchName,
            input.trunkBranch,
            input.runtimeConfig
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, metadata: result.data.metadata };
        }),
      remove: t
        .input(schemas.workspace.remove.input)
        .output(schemas.workspace.remove.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.remove(
            input.workspaceId,
            input.options?.force
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true };
        }),
      rename: t
        .input(schemas.workspace.rename.input)
        .output(schemas.workspace.rename.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.rename(input.workspaceId, input.newName);
        }),
      fork: t
        .input(schemas.workspace.fork.input)
        .output(schemas.workspace.fork.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.fork(
            input.sourceWorkspaceId,
            input.newName
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return {
            success: true,
            metadata: result.data.metadata,
            projectPath: result.data.projectPath,
          };
        }),
      sendMessage: t
        .input(schemas.workspace.sendMessage.input)
        .output(schemas.workspace.sendMessage.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.sendMessage(
            input.workspaceId,
            input.message,
            input.options
          );

          if (!result.success) {
            return { success: false, error: result.error };
          }

          return { success: true, data: {} };
        }),
      resumeStream: t
        .input(schemas.workspace.resumeStream.input)
        .output(schemas.workspace.resumeStream.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.resumeStream(
            input.workspaceId,
            input.options
          );
          if (!result.success) {
            const error =
              typeof result.error === "string"
                ? { type: "unknown" as const, raw: result.error }
                : result.error;
            return { success: false, error };
          }
          return { success: true, data: undefined };
        }),
      interruptStream: t
        .input(schemas.workspace.interruptStream.input)
        .output(schemas.workspace.interruptStream.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.interruptStream(
            input.workspaceId,
            input.options
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      clearQueue: t
        .input(schemas.workspace.clearQueue.input)
        .output(schemas.workspace.clearQueue.output)
        .handler(({ context, input }) => {
          const result = context.workspaceService.clearQueue(input.workspaceId);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      truncateHistory: t
        .input(schemas.workspace.truncateHistory.input)
        .output(schemas.workspace.truncateHistory.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.truncateHistory(
            input.workspaceId,
            input.percentage
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      replaceChatHistory: t
        .input(schemas.workspace.replaceChatHistory.input)
        .output(schemas.workspace.replaceChatHistory.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.replaceHistory(
            input.workspaceId,
            input.summaryMessage
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      getInfo: t
        .input(schemas.workspace.getInfo.input)
        .output(schemas.workspace.getInfo.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getInfo(input.workspaceId);
        }),
      getFullReplay: t
        .input(schemas.workspace.getFullReplay.input)
        .output(schemas.workspace.getFullReplay.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getFullReplay(input.workspaceId);
        }),
      executeBash: t
        .input(schemas.workspace.executeBash.input)
        .output(schemas.workspace.executeBash.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.executeBash(
            input.workspaceId,
            input.script,
            input.options
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: result.data };
        }),
      onChat: t
        .input(schemas.workspace.onChat.input)
        .output(schemas.workspace.onChat.output)
        .handler(async function* ({ context, input }) {
          const session = context.workspaceService.getOrCreateSession(input.workspaceId);
          const { push, iterate, end } = createAsyncMessageQueue<WorkspaceChatMessage>();

          // 1. Subscribe to new events (including those triggered by replay)
          const unsubscribe = session.onChatEvent(({ message }) => {
            push(message);
          });

          // 2. Replay history (sends caught-up at the end)
          await session.replayHistory(({ message }) => {
            push(message);
          });

          try {
            yield* iterate();
          } finally {
            end();
            unsubscribe();
          }
        }),
      onMetadata: t
        .input(schemas.workspace.onMetadata.input)
        .output(schemas.workspace.onMetadata.output)
        .handler(async function* ({ context }) {
          const service = context.workspaceService;

          let resolveNext:
            | ((value: {
                workspaceId: string;
                metadata: FrontendWorkspaceMetadataSchemaType | null;
              }) => void)
            | null = null;
          const queue: Array<{
            workspaceId: string;
            metadata: FrontendWorkspaceMetadataSchemaType | null;
          }> = [];
          let ended = false;

          const push = (event: {
            workspaceId: string;
            metadata: FrontendWorkspaceMetadataSchemaType | null;
          }) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(event);
            } else {
              queue.push(event);
            }
          };

          const onMetadata = (event: {
            workspaceId: string;
            metadata: FrontendWorkspaceMetadataSchemaType | null;
          }) => {
            push(event);
          };

          service.on("metadata", onMetadata);

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
              } else {
                const event = await new Promise<{
                  workspaceId: string;
                  metadata: FrontendWorkspaceMetadataSchemaType | null;
                }>((resolve) => {
                  resolveNext = resolve;
                });
                yield event;
              }
            }
          } finally {
            ended = true;
            service.off("metadata", onMetadata);
          }
        }),
      activity: {
        list: t
          .input(schemas.workspace.activity.list.input)
          .output(schemas.workspace.activity.list.output)
          .handler(async ({ context }) => {
            return context.workspaceService.getActivityList();
          }),
        subscribe: t
          .input(schemas.workspace.activity.subscribe.input)
          .output(schemas.workspace.activity.subscribe.output)
          .handler(async function* ({ context }) {
            const service = context.workspaceService;

            let resolveNext:
              | ((value: {
                  workspaceId: string;
                  activity: WorkspaceActivitySnapshot | null;
                }) => void)
              | null = null;
            const queue: Array<{
              workspaceId: string;
              activity: WorkspaceActivitySnapshot | null;
            }> = [];
            let ended = false;

            const push = (event: {
              workspaceId: string;
              activity: WorkspaceActivitySnapshot | null;
            }) => {
              if (ended) return;
              if (resolveNext) {
                const resolve = resolveNext;
                resolveNext = null;
                resolve(event);
              } else {
                queue.push(event);
              }
            };

            const onActivity = (event: {
              workspaceId: string;
              activity: WorkspaceActivitySnapshot | null;
            }) => {
              push(event);
            };

            service.on("activity", onActivity);

            try {
              while (!ended) {
                if (queue.length > 0) {
                  yield queue.shift()!;
                } else {
                  const event = await new Promise<{
                    workspaceId: string;
                    activity: WorkspaceActivitySnapshot | null;
                  }>((resolve) => {
                    resolveNext = resolve;
                  });
                  yield event;
                }
              }
            } finally {
              ended = true;
              service.off("activity", onActivity);
            }
          }),
      },
      getPlanContent: t
        .input(schemas.workspace.getPlanContent.input)
        .output(schemas.workspace.getPlanContent.output)
        .handler(({ input }) => {
          const planPath = getPlanFilePath(input.workspaceId);
          const content = readPlanFile(input.workspaceId);
          if (content === null) {
            return { success: false as const, error: `Plan file not found at ${planPath}` };
          }
          return { success: true as const, data: { content, path: planPath } };
        }),
    },
    window: {
      setTitle: t
        .input(schemas.window.setTitle.input)
        .output(schemas.window.setTitle.output)
        .handler(({ context, input }) => {
          return context.windowService.setTitle(input.title);
        }),
    },
    terminal: {
      create: t
        .input(schemas.terminal.create.input)
        .output(schemas.terminal.create.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.create(input);
        }),
      close: t
        .input(schemas.terminal.close.input)
        .output(schemas.terminal.close.output)
        .handler(({ context, input }) => {
          return context.terminalService.close(input.sessionId);
        }),
      resize: t
        .input(schemas.terminal.resize.input)
        .output(schemas.terminal.resize.output)
        .handler(({ context, input }) => {
          return context.terminalService.resize(input);
        }),
      sendInput: t
        .input(schemas.terminal.sendInput.input)
        .output(schemas.terminal.sendInput.output)
        .handler(({ context, input }) => {
          context.terminalService.sendInput(input.sessionId, input.data);
        }),
      onOutput: t
        .input(schemas.terminal.onOutput.input)
        .output(schemas.terminal.onOutput.output)
        .handler(async function* ({ context, input }) {
          let resolveNext: ((value: string) => void) | null = null;
          const queue: string[] = [];
          let ended = false;

          const push = (data: string) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(data);
            } else {
              queue.push(data);
            }
          };

          const unsubscribe = context.terminalService.onOutput(input.sessionId, push);

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
              } else {
                const data = await new Promise<string>((resolve) => {
                  resolveNext = resolve;
                });
                yield data;
              }
            }
          } finally {
            ended = true;
            unsubscribe();
          }
        }),
      onExit: t
        .input(schemas.terminal.onExit.input)
        .output(schemas.terminal.onExit.output)
        .handler(async function* ({ context, input }) {
          let resolveNext: ((value: number) => void) | null = null;
          const queue: number[] = [];
          let ended = false;

          const push = (code: number) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(code);
            } else {
              queue.push(code);
            }
          };

          const unsubscribe = context.terminalService.onExit(input.sessionId, push);

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                // Terminal only exits once, so we can finish the stream
                break;
              } else {
                const code = await new Promise<number>((resolve) => {
                  resolveNext = resolve;
                });
                yield code;
                break;
              }
            }
          } finally {
            ended = true;
            unsubscribe();
          }
        }),
      openWindow: t
        .input(schemas.terminal.openWindow.input)
        .output(schemas.terminal.openWindow.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.openWindow(input.workspaceId);
        }),
      closeWindow: t
        .input(schemas.terminal.closeWindow.input)
        .output(schemas.terminal.closeWindow.output)
        .handler(({ context, input }) => {
          return context.terminalService.closeWindow(input.workspaceId);
        }),
      openNative: t
        .input(schemas.terminal.openNative.input)
        .output(schemas.terminal.openNative.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.openNative(input.workspaceId);
        }),
    },
    update: {
      check: t
        .input(schemas.update.check.input)
        .output(schemas.update.check.output)
        .handler(async ({ context }) => {
          return context.updateService.check();
        }),
      download: t
        .input(schemas.update.download.input)
        .output(schemas.update.download.output)
        .handler(async ({ context }) => {
          return context.updateService.download();
        }),
      install: t
        .input(schemas.update.install.input)
        .output(schemas.update.install.output)
        .handler(({ context }) => {
          return context.updateService.install();
        }),
      onStatus: t
        .input(schemas.update.onStatus.input)
        .output(schemas.update.onStatus.output)
        .handler(async function* ({ context }) {
          let resolveNext: ((value: UpdateStatus) => void) | null = null;
          const queue: UpdateStatus[] = [];
          let ended = false;

          const push = (status: UpdateStatus) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(status);
            } else {
              queue.push(status);
            }
          };

          const unsubscribe = context.updateService.onStatus(push);

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
              } else {
                const status = await new Promise<UpdateStatus>((resolve) => {
                  resolveNext = resolve;
                });
                yield status;
              }
            }
          } finally {
            ended = true;
            unsubscribe();
          }
        }),
    },
    menu: {
      onOpenSettings: t
        .input(schemas.menu.onOpenSettings.input)
        .output(schemas.menu.onOpenSettings.output)
        .handler(async function* ({ context }) {
          let resolveNext: (() => void) | null = null;
          let ended = false;

          const push = () => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            }
          };

          const unsubscribe = context.menuEventService.onOpenSettings(push);

          try {
            while (!ended) {
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });
              yield undefined;
            }
          } finally {
            ended = true;
            unsubscribe();
          }
        }),
    },
    voice: {
      transcribe: t
        .input(schemas.voice.transcribe.input)
        .output(schemas.voice.transcribe.output)
        .handler(async ({ context, input }) => {
          return context.voiceService.transcribe(input.audioBase64);
        }),
    },
    debug: {
      triggerStreamError: t
        .input(schemas.debug.triggerStreamError.input)
        .output(schemas.debug.triggerStreamError.output)
        .handler(({ context, input }) => {
          return context.workspaceService.debugTriggerStreamError(
            input.workspaceId,
            input.errorMessage
          );
        }),
    },
    telemetry: {
      track: t
        .input(schemas.telemetry.track.input)
        .output(schemas.telemetry.track.output)
        .handler(({ context, input }) => {
          context.telemetryService.capture(input);
        }),
    },
  });
};

export type AppRouter = ReturnType<typeof router>;
