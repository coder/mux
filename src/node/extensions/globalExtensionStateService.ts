import type { Config } from "@/node/config";
import {
  GLOBAL_EXTENSION_STATE_SCHEMA_VERSION,
  normalizeGlobalExtensionState,
  type ExtensionStateRecord,
  type ApprovalRecord,
  type NormalizeGlobalExtensionStateResult,
} from "@/common/extensions/globalExtensionState";

// Persists the extensions block of ~/.mux/config.json via Config's atomic
// write-temp-then-rename. Validation and self-healing live in
// normalizeGlobalExtensionState (pure module).
//
// Invariants:
// - Empty/missing/malformed state never implies trust or approvals.
// - Bundled Extensions default to enabled=true when no record exists.
// - Unknown future schemaVersion values are preserved on disk on load; only
//   an explicit mutation rewrites the block to the current schemaVersion.
export class GlobalExtensionStateService {
  constructor(private readonly config: Config) {}

  load(): NormalizeGlobalExtensionStateResult {
    const cfg = this.config.loadConfigOrDefault();
    return normalizeGlobalExtensionState(cfg.extensions);
  }

  isEnabled(extensionId: string, { isBundled }: { isBundled: boolean }): boolean {
    const { state } = this.load();
    return state.extensions[extensionId]?.enabled ?? isBundled;
  }

  async setEnabled(extensionId: string, enabled: boolean): Promise<void> {
    await this.mutateRecord(extensionId, (record) => ({ ...record, enabled }));
  }

  async setApproval(extensionId: string, approval: ApprovalRecord): Promise<void> {
    await this.mutateRecord(extensionId, (record) => ({ ...record, approval }));
  }

  async removeApproval(extensionId: string): Promise<void> {
    await this.mutateRecord(extensionId, ({ enabled }) => ({ enabled }));
  }

  async forget(extensionId: string): Promise<void> {
    await this.mutateRecord(extensionId, () => null);
  }

  private async mutateRecord(
    extensionId: string,
    fn: (current: ExtensionStateRecord) => ExtensionStateRecord | null
  ): Promise<void> {
    await this.config.editConfig((cfg) => {
      const { state } = normalizeGlobalExtensionState(cfg.extensions);
      const next = fn(state.extensions[extensionId] ?? {});
      const extensions = { ...state.extensions };
      if (next == null || (next.enabled === undefined && next.approval === undefined)) {
        delete extensions[extensionId];
      } else {
        extensions[extensionId] = next;
      }
      cfg.extensions = { schemaVersion: GLOBAL_EXTENSION_STATE_SCHEMA_VERSION, extensions };
      return cfg;
    });
  }
}
