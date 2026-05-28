import * as path from "path";
import crypto from "crypto";
import { mkdir, readFile } from "fs/promises";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import {
  PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
  normalizeProjectExtensionState,
  type NormalizeProjectExtensionStateResult,
} from "@/common/extensions/projectExtensionState";
import type {
  ExtensionStateRecord,
  ApprovalRecord,
} from "@/common/extensions/globalExtensionState";
import { log } from "@/node/services/log";

const PROJECT_EXTENSION_STATE_FILE = "extensions.local.jsonc";

interface ProjectExtensionStateOnDisk {
  schemaVersion: typeof PROJECT_EXTENSION_STATE_SCHEMA_VERSION;
  rootTrusted?: boolean;
  extensions?: Record<string, ExtensionStateRecord>;
}

export function getProjectExtensionStateRoot(muxRoot: string): string {
  return path.join(muxRoot, "extensions", "project-state");
}

function projectStateKey(projectPath: string): string {
  const canonical = path.resolve(projectPath);
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

// Persists per-project Trusted Extension Root flag plus per-Extension
// enablement and approval records under Mux-owned global state via
// write-file-atomic. Validation and self-healing live in the pure
// normalizeProjectExtensionState module.
//
// Invariants:
// - Empty/missing/malformed state never implies trust or approvals.
// - rootTrusted defaults to false when no record exists.
// - Unknown future schemaVersion values are preserved on disk on load; only
//   an explicit mutation rewrites the file at the current schemaVersion.
// - Project repositories are never consulted for this state. Gitignore is not
//   a security boundary; keeping approvals under Mux-owned storage prevents a
//   repo from injecting extension trust by committing `.mux` files.
export class ProjectExtensionStateService {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateRoot: string) {}

  filePathFor(projectPath: string): string {
    return path.join(this.stateRoot, projectStateKey(projectPath), PROJECT_EXTENSION_STATE_FILE);
  }

  async load(projectPath: string): Promise<NormalizeProjectExtensionStateResult> {
    const raw = await this.readRaw(projectPath);
    return normalizeProjectExtensionState(raw);
  }

  async isRootTrusted(projectPath: string): Promise<boolean> {
    return (await this.load(projectPath)).state.rootTrusted;
  }

  async setRootTrusted(projectPath: string, trusted: boolean): Promise<void> {
    await this.enqueue(async () => {
      const { state } = await this.load(projectPath);
      await this.write(projectPath, trusted, state.extensions);
    });
  }

  async setEnabled(projectPath: string, extensionId: string, enabled: boolean): Promise<void> {
    await this.mutateRecord(projectPath, extensionId, (record) => ({ ...record, enabled }));
  }

  async setApproval(
    projectPath: string,
    extensionId: string,
    approval: ApprovalRecord
  ): Promise<void> {
    await this.mutateRecord(projectPath, extensionId, (record) => ({ ...record, approval }));
  }

  async removeApproval(projectPath: string, extensionId: string): Promise<void> {
    await this.mutateRecord(projectPath, extensionId, ({ enabled }) => ({ enabled }));
  }

  async forget(projectPath: string, extensionId: string): Promise<void> {
    await this.mutateRecord(projectPath, extensionId, () => null);
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async readRaw(projectPath: string): Promise<unknown> {
    const filePath = this.filePathFor(projectPath);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return undefined;
    }
    const errors: jsonc.ParseError[] = [];
    const parsed: unknown = jsonc.parse(content, errors) as unknown;
    if (errors.length > 0) {
      log.warn("[extensions] Failed to parse project extension state (JSONC parse errors)", {
        filePath,
        errorCount: errors.length,
      });
      return {};
    }
    return parsed;
  }

  private async mutateRecord(
    projectPath: string,
    extensionId: string,
    fn: (current: ExtensionStateRecord) => ExtensionStateRecord | null
  ): Promise<void> {
    await this.enqueue(async () => {
      const { state } = await this.load(projectPath);
      const next = fn(state.extensions[extensionId] ?? {});
      const extensions = { ...state.extensions };
      if (next == null || (next.enabled === undefined && next.approval === undefined)) {
        delete extensions[extensionId];
      } else {
        extensions[extensionId] = next;
      }
      await this.write(projectPath, state.rootTrusted, extensions);
    });
  }

  private async write(
    projectPath: string,
    rootTrusted: boolean,
    extensions: Record<string, ExtensionStateRecord>
  ): Promise<void> {
    const filePath = this.filePathFor(projectPath);
    await mkdir(path.dirname(filePath), { recursive: true });

    const onDisk: ProjectExtensionStateOnDisk = {
      schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
    };
    if (rootTrusted) {
      onDisk.rootTrusted = true;
    }
    if (Object.keys(extensions).length > 0) {
      onDisk.extensions = extensions;
    }

    await writeFileAtomic(filePath, JSON.stringify(onDisk, null, 2) + "\n", "utf-8");
  }
}
