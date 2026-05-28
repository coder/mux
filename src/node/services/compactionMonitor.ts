import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import {
  DEFAULT_AUTO_COMPACTION_THRESHOLD,
  FORCE_COMPACTION_BUFFER_PERCENT,
} from "@/common/constants/ui";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import {
  checkAutoCompaction,
  type AutoCompactionCheckResult,
  type AutoCompactionUsageState,
} from "@/common/utils/compaction/autoCompactionCheck";
import { getEffectiveContextLimit } from "@/common/utils/compaction/contextLimit";

export type CompactionStatusEvent =
  | {
      type: "auto-compaction-triggered";
      reason: "on-send" | "mid-stream" | "idle";
      usagePercent: number;
    }
  | {
      type: "auto-compaction-completed";
      newUsagePercent: number;
    };

interface CheckBeforeSendParams {
  model: string | null;
  usage: AutoCompactionUsageState | undefined;
  use1MContext: boolean;
  providersConfig: ProvidersConfigMap | null;
  /**
   * Optional per-call threshold override (decimal 0–1). When provided and
   * finite, replaces `this.threshold` for the duration of this check —
   * the monitor's own threshold (set by the renderer's per-model slider)
   * is untouched. Callers use this to layer the active goal's per-goal
   * `autoCompactionThresholdPct` on top of the workspace setting without
   * mutating the monitor's persistent state. A value `>= 1` disables
   * compaction for this check just like `setThreshold(1)` does.
   */
  thresholdOverride?: number | null;
}

interface CheckMidStreamParams {
  model: string;
  usage: LanguageModelV2Usage;
  use1MContext: boolean;
  providersConfig: ProvidersConfigMap | null;
  /** See `CheckBeforeSendParams.thresholdOverride`. */
  thresholdOverride?: number | null;
}

/**
 * Tracks context-window pressure and decides when auto-compaction should trigger.
 */
export class CompactionMonitor {
  private threshold = DEFAULT_AUTO_COMPACTION_THRESHOLD;
  private hasTriggeredForCurrentStream = false;

  constructor(
    private readonly workspaceId: string,
    private readonly onStatusChange: (event: CompactionStatusEvent) => void
  ) {
    assert(typeof workspaceId === "string", "CompactionMonitor requires a string workspaceId");
    assert(workspaceId.trim().length > 0, "CompactionMonitor requires a non-empty workspaceId");
    assert(
      typeof onStatusChange === "function",
      "CompactionMonitor requires an onStatusChange callback"
    );
  }

  /**
   * Called before sending a new message. The caller decides how to act on the result.
   */
  checkBeforeSend(params: CheckBeforeSendParams): AutoCompactionCheckResult {
    assert(
      params !== null && params !== undefined,
      "CompactionMonitor.checkBeforeSend requires params"
    );

    return checkAutoCompaction(
      params.usage,
      params.model,
      params.use1MContext,
      this.resolveEffectiveThreshold(params.thresholdOverride),
      undefined,
      params.providersConfig
    );
  }

  /**
   * Called on each usage-delta during streaming.
   * Returns true when mid-stream compaction should be triggered.
   */
  checkMidStream(params: CheckMidStreamParams): boolean {
    assert(
      params !== null && params !== undefined,
      "CompactionMonitor.checkMidStream requires params"
    );
    assert(
      params.model.trim().length > 0,
      "CompactionMonitor.checkMidStream requires a non-empty model"
    );

    if (this.hasTriggeredForCurrentStream) {
      return false;
    }

    const effectiveThreshold = this.resolveEffectiveThreshold(params.thresholdOverride);
    // Threshold 1.0 means auto-compaction is disabled.
    if (effectiveThreshold >= 1) {
      return false;
    }

    const contextLimit = getEffectiveContextLimit(
      params.model,
      params.use1MContext,
      params.providersConfig
    );
    // Defensive: malformed provider overrides can yield invalid/non-positive limits.
    // Treat those as "no compaction signal" instead of throwing inside usage-delta handlers.
    if (!contextLimit || contextLimit <= 0) {
      return false;
    }

    // AI SDK v6 reports inputTokens as the full prompt context (including cache reads),
    // so adding cachedInputTokens here double-counts prompt-cached requests.
    // Fallback to cachedInputTokens only when inputTokens is unavailable.
    const usageTokens = params.usage.inputTokens ?? params.usage.cachedInputTokens ?? 0;
    assert(
      usageTokens >= 0,
      `CompactionMonitor(${this.workspaceId}): usage tokens must be non-negative`
    );

    const usagePercent = (usageTokens / contextLimit) * 100;
    const forceThresholdPercent = effectiveThreshold * 100 + FORCE_COMPACTION_BUFFER_PERCENT;

    if (usagePercent < forceThresholdPercent) {
      return false;
    }

    this.hasTriggeredForCurrentStream = true;
    this.onStatusChange({
      type: "auto-compaction-triggered",
      reason: "mid-stream",
      usagePercent: Math.round(usagePercent),
    });
    return true;
  }

  resetForNewStream(): void {
    this.hasTriggeredForCurrentStream = false;
  }

  setThreshold(threshold: number): void {
    assert(
      Number.isFinite(threshold),
      `CompactionMonitor(${this.workspaceId}): threshold must be finite`
    );
    assert(
      threshold > 0 && threshold <= 1,
      `CompactionMonitor(${this.workspaceId}): invalid threshold ${threshold}`
    );
    this.threshold = threshold;
  }

  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Pick the threshold that should govern this single check. A finite,
   * in-range override (passed by the caller, typically derived from the
   * active goal's `autoCompactionThresholdPct`) wins over the monitor's
   * own per-workspace value. We intentionally keep validation loose
   * here: `null` / `undefined` / non-finite / negative values fall back
   * to `this.threshold` instead of throwing, because the override is
   * sourced from optional persisted state and a malformed entry must
   * never brick the compaction pipeline mid-stream.
   *
   * `0` is honored as "compact at 0% context" (i.e. compact on every
   * send) — the schema admits it as a valid extreme of the aggressive
   * end of the slider, and treating it as a fallback would silently
   * make the renderer and backend disagree on what the override means
   * (renderer renders "0%", backend behaves as workspace default).
   */
  private resolveEffectiveThreshold(override: number | null | undefined): number {
    if (override == null) return this.threshold;
    if (!Number.isFinite(override)) return this.threshold;
    // Only negative values are corrupt; `0` is a valid per-goal extreme.
    if (override < 0) return this.threshold;
    // Clamp the upper bound so an out-of-range "200%" override behaves the
    // same way `setThreshold(1)` would: compaction disabled, not skewed
    // higher than the model's actual context.
    return Math.min(override, 1);
  }
}
