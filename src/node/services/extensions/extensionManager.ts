import type { Tool } from "ai";
import { log } from "@/node/services/log";
import { discoverExtensions, type ExtensionInfo } from "@/node/utils/extensions/discovery";
import { getMuxExtDir } from "@/common/constants/paths";
import type { Runtime } from "@/node/runtime/Runtime";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { Extension, PostToolUseHookPayload, PostToolUseHookReturn } from "./types";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeExtensionExport(exported: unknown): Extension | null {
  // Support both:
  // - module.exports = { ... }
  // - module.exports = { default: { ... } }
  const candidate = (() => {
    if (typeof exported === "object" && exported !== null) {
      const rec = exported as Record<string, unknown>;
      if ("default" in rec) {
        return rec.default;
      }
    }
    return exported;
  })();

  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }

  // NOTE: We don't validate every property; we just check that it's an object.
  // Hook existence is checked at call time.
  return candidate as Extension;
}

function getToolCallIdFromOptions(options: unknown): string {
  if (typeof options !== "object" || options === null) {
    return "unknown";
  }
  const rec = options as Record<string, unknown>;
  const value = rec.toolCallId;
  return typeof value === "string" ? value : "unknown";
}

export interface ExtensionManagerOptions {
  /** Override extension directory (useful for tests) */
  extDir?: string;
  /** Per-extension hook timeout */
  hookTimeoutMs?: number;
}

interface LoadedExtension {
  id: string;
  entryPath: string;
  extension: Extension;
}

export interface WrapToolsContext {
  workspaceId: string;
  projectPath: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfig;
  runtimeTempDir: string;
  runtime: Runtime;
}

export class ExtensionManager {
  private readonly extDir: string;
  private readonly hookTimeoutMs: number;

  private initPromise: Promise<void> | null = null;
  private loaded: LoadedExtension[] = [];

  constructor(options?: ExtensionManagerOptions) {
    this.extDir = options?.extDir ?? getMuxExtDir();
    this.hookTimeoutMs = options?.hookTimeoutMs ?? 5000;
  }

  private async initializeOnce(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const discovered = await discoverExtensions(this.extDir);
      if (discovered.length === 0) {
        log.debug("No extensions discovered", { extDir: this.extDir });
        return;
      }

      log.info(`Loading ${discovered.length} extension(s) from ${this.extDir}`);

      const loaded: LoadedExtension[] = [];
      for (const ext of discovered) {
        const result = this.loadExtension(ext);
        if (result) {
          loaded.push(result);
        }
      }

      this.loaded = loaded;
      log.info(`Loaded ${loaded.length}/${discovered.length} extension(s)`);
    })();

    return this.initPromise;
  }

  private loadExtension(ext: ExtensionInfo): LoadedExtension | null {
    try {
      const exported: unknown = require(ext.entryPath);
      const normalized = normalizeExtensionExport(exported);
      if (!normalized) {
        log.warn("Extension did not export an object", { id: ext.id, entryPath: ext.entryPath });
        return null;
      }

      return { id: ext.id, entryPath: ext.entryPath, extension: normalized };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to load extension", { id: ext.id, entryPath: ext.entryPath, error: message });
      return null;
    }
  }

  private async runPostToolUseHook(payload: PostToolUseHookPayload): Promise<unknown> {
    await this.initializeOnce();
    if (this.loaded.length === 0) {
      return payload.result;
    }

    let currentResult: unknown = payload.result;

    for (const loaded of this.loaded) {
      const handler = loaded.extension.onPostToolUse;
      if (!handler) {
        continue;
      }

      try {
        const hookPayload: PostToolUseHookPayload = { ...payload, result: currentResult };
        const returned = await withTimeout(
          Promise.resolve(handler(hookPayload)),
          this.hookTimeoutMs,
          `Extension ${loaded.id} onPostToolUse`
        );

        const cast = returned as PostToolUseHookReturn;
        if (typeof cast === "object" && cast !== null && "result" in cast) {
          currentResult = (cast as { result: unknown }).result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Extension onPostToolUse failed", {
          id: loaded.id,
          entryPath: loaded.entryPath,
          toolName: payload.toolName,
          error: message,
        });
      }
    }

    return currentResult;
  }

  /**
   * Wrap tools so that after each tool executes, we call extensions' onPostToolUse hooks.
   *
   * If an extension returns { result }, that becomes the tool result returned to the model.
   */
  wrapToolsWithPostToolUse(tools: Record<string, Tool>, ctx: WrapToolsContext): Record<string, Tool> {
    const wrapped: Record<string, Tool> = {};

    for (const [toolName, tool] of Object.entries(tools)) {
      if (!tool.execute) {
        wrapped[toolName] = tool;
        continue;
      }

      const originalExecute = tool.execute;
      wrapped[toolName] = {
        ...tool,
        execute: async (args: Parameters<typeof originalExecute>[0], options) => {
          const result: unknown = await originalExecute(args, options);

          const toolCallId = getToolCallIdFromOptions(options);
          return this.runPostToolUseHook({
            workspaceId: ctx.workspaceId,
            projectPath: ctx.projectPath,
            workspacePath: ctx.workspacePath,
            runtimeConfig: ctx.runtimeConfig,
            runtimeTempDir: ctx.runtimeTempDir,
            toolName,
            toolCallId,
            args,
            result,
            timestamp: Date.now(),
            runtime: ctx.runtime,
          });
        },
      };
    }

    return wrapped;
  }
}
