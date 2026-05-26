import { useEffect, useMemo, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import { useAgent } from "@/browser/contexts/AgentContext";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { formatAgentIdLabel } from "@/browser/components/AgentModePicker/AgentModePicker";
import { getAgentIcon } from "@/browser/utils/agentIcons";
import { isAbortError } from "@/browser/utils/isAbortError";
import { cn } from "@/common/lib/utils";
import type { AgentDefinitionPackage } from "@/common/types/agentDefinition";
import { getErrorMessage } from "@/common/utils/errors";

interface ModeInstructionsPanelProps {
  workspaceId: string;
}

/**
 * Mode instructions panel — renders the system prompt body of the currently
 * selected agent (a.k.a. "mode") so the user can see exactly what guidance
 * the agent is starting each turn with. The panel is keyed on the agent id
 * so switching modes triggers a fresh fetch + a smooth color transition.
 *
 * Styling intentionally pulls from the agent's `uiColor` (the same hue used
 * by the mode picker pill and the chat-input focus ring) so the Instructions
 * tab visibly tracks the mode you're in.
 */
export function ModeInstructionsPanel(props: ModeInstructionsPanelProps) {
  const { api } = useAPI();
  const { agentId, currentAgent, loaded } = useAgent();
  // Cache the (agentId, workspaceId) the loaded `pkg` belongs to so we can
  // invalidate it on either dimension. An `exec.md` in workspace A and an
  // `exec.md` in workspace B can have completely different bodies, so a bare
  // `pkg.id === agentId` check is not enough.
  const [pkgKey, setPkgKey] = useState<{ agentId: string; workspaceId: string } | null>(null);
  const [pkg, setPkg] = useState<AgentDefinitionPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  // Use the descriptor's uiColor (already inheritance-resolved on the
  // backend); fall back to the neutral border var so the section never has
  // an undefined CSS color while agents are still loading.
  const color = currentAgent?.uiColor ?? "var(--color-border-light)";

  useEffect(() => {
    if (!api || !agentId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const requestWorkspaceId = props.workspaceId;
    const requestAgentId = agentId;
    api.agents
      .get(
        { workspaceId: requestWorkspaceId, agentId: requestAgentId },
        { signal: controller.signal }
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        setPkg(result);
        setPkgKey({ agentId: requestAgentId, workspaceId: requestWorkspaceId });
        setLoading(false);
      })
      .catch((err) => {
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(getErrorMessage(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [api, agentId, props.workspaceId, refreshTick]);

  // Guard against stale data leaking across mode *and* workspace switches:
  // when either dimension changes, the previous fetch could still resolve
  // and we'd otherwise keep rendering the wrong body (and its token count)
  // under the new mode's color/name until the new response arrives. Treat
  // any pkg whose (agentId, workspaceId) doesn't match the current
  // selection as "not loaded yet" so the body section falls back to the
  // loading/empty state instead of showing the wrong prompt.
  const pkgMatchesContext =
    pkgKey?.agentId === agentId && pkgKey?.workspaceId === props.workspaceId;
  const effectivePkg = pkgMatchesContext ? pkg : null;

  const displayName = currentAgent?.name ?? formatAgentIdLabel(agentId);
  const description = currentAgent?.description ?? effectivePkg?.frontmatter.description;
  const scope = currentAgent?.scope ?? effectivePkg?.scope;
  const body = effectivePkg?.body ?? "";
  const hasBody = body.trim().length > 0;

  // Approximate token count (rough heuristic: 4 chars ≈ 1 token). We don't
  // need precision here — the goal is to give a sense of how much prompt is
  // being injected, similar to the totals in the Instructions header.
  const approxTokens = useMemo(() => {
    if (!hasBody) return 0;
    return Math.max(1, Math.round(body.length / 4));
  }, [body, hasBody]);

  const Icon = getAgentIcon(agentId);

  // Section background uses a very light tint of the mode color so it stands
  // out from the surrounding panel without overpowering the contained
  // markdown. The left edge gets a thicker accent bar in the mode color.
  // `--mode-color` is exposed as a custom property so descendants can reuse
  // the same hue without redefining the mix expression.
  const sectionStyle: React.CSSProperties & Record<"--mode-color", string> = {
    "--mode-color": color,
    backgroundColor: `color-mix(in srgb, ${color} 6%, transparent)`,
    borderLeftColor: color,
  };

  return (
    <section
      className="border-border border-b border-l-[3px] px-3 py-3 transition-colors duration-200"
      style={sectionStyle}
      data-component="ModeInstructionsPanel"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="group flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-expanded={expanded}
          aria-label={`Toggle ${displayName} mode instructions`}
        >
          <span
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded"
            style={{
              backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`,
              color,
            }}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-xs font-semibold tracking-tight" style={{ color }}>
                {displayName}
              </h3>
              <span className="text-muted text-[9px] tracking-wider uppercase">
                {loaded ? "mode" : "loading…"}
              </span>
              {scope && scope !== "built-in" && (
                <span
                  className="rounded px-1.5 py-0.5 text-[9px] tracking-wider uppercase"
                  style={{
                    color,
                    backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
                  }}
                >
                  {scope}
                </span>
              )}
              {hasBody && (
                <span className="counter-nums text-muted ml-auto shrink-0 text-[10px]">
                  ~{formatTokens(approxTokens)} tokens
                </span>
              )}
            </div>
            {description && (
              <p className="text-muted mt-0.5 line-clamp-2 text-[11px] leading-snug">
                {description}
              </p>
            )}
          </div>
          <span
            className={cn(
              "text-muted mt-1 shrink-0 transition-transform duration-150",
              expanded && "rotate-90"
            )}
            aria-hidden="true"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="text-muted hover:text-foreground -mr-1 rounded p-1 transition-colors disabled:opacity-50"
              onClick={() => setRefreshTick((n) => n + 1)}
              disabled={loading}
              aria-label="Reload mode instructions"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Re-read mode definition</TooltipContent>
        </Tooltip>
      </div>

      {expanded && (
        <div
          className="mt-3 overflow-hidden rounded border"
          style={{
            borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
            backgroundColor: "var(--color-background)",
          }}
        >
          {loading && !effectivePkg && (
            <div className="text-muted px-3 py-4 text-center text-xs">
              Loading mode instructions…
            </div>
          )}
          {error && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive m-2 rounded border px-3 py-2 text-xs">
              Failed to load mode instructions: {error}
            </div>
          )}
          {!loading && !error && !hasBody && (
            <div className="text-muted px-3 py-4 text-center text-xs">
              This mode does not define any custom instructions.
            </div>
          )}
          {hasBody && (
            // Cap the height so a multi-KB prompt doesn't push the rest of
            // the panel off-screen; the inner block scrolls independently.
            <div className="max-h-[40vh] overflow-y-auto px-3 py-2 text-[12px] leading-relaxed">
              <MarkdownRenderer content={body} />
            </div>
          )}
        </div>
      )}

      {!expanded && hasBody && (
        <div
          className="mt-2 line-clamp-1 truncate rounded px-2 py-1 text-[11px]"
          style={{
            backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
            color: "var(--color-muted)",
          }}
          title={firstNonEmptyLine(body)}
        >
          {firstNonEmptyLine(body) || "(empty)"}
        </div>
      )}
    </section>
  );
}

/**
 * Find the first non-blank line in a (potentially long) markdown body. Used
 * for the collapsed preview so the user can identify the prompt at a glance.
 */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
