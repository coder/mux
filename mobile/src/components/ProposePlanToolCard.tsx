import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import type {
  LegacyProposePlanToolArgs,
  ProposePlanToolResult,
  ToolErrorResult,
} from "@/common/types/tools";
import { ProposePlanCard } from "./ProposePlanCard";
import { Surface } from "./Surface";
import { ThemedText } from "./ThemedText";
import { useORPC } from "../orpc/react";

type ToolStatus = "pending" | "executing" | "completed" | "failed" | "interrupted";

interface ProposePlanToolCardProps {
  args: unknown;
  result: unknown;
  status: ToolStatus;
  toolCallId: string;
  workspaceId?: string;
  onStartHere?: (content: string) => Promise<void>;
}

function unwrapJsonContainer(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "json" && "value" in record) {
    return record.value;
  }

  return value;
}

function isToolErrorResult(val: unknown): val is ToolErrorResult {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  return record.success === false && typeof record.error === "string";
}

function isLegacyProposePlanToolArgs(val: unknown): val is LegacyProposePlanToolArgs {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  return typeof record.title === "string" && typeof record.plan === "string";
}

function isProposePlanToolResult(
  val: unknown
): val is ProposePlanToolResult & { planContent?: string } {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  if (record.success !== true) {
    return false;
  }

  return typeof record.planPath === "string";
}

function extractTitleFromMarkdown(markdown: string): string | null {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match ? match[1] : null;
}

export function ProposePlanToolCard(props: ProposePlanToolCardProps): JSX.Element {
  const client = useORPC();

  const legacyArgs = useMemo(() => {
    return isLegacyProposePlanToolArgs(props.args) ? props.args : null;
  }, [props.args]);

  const unwrappedResult = useMemo(() => unwrapJsonContainer(props.result), [props.result]);

  const successResult = useMemo(() => {
    return isProposePlanToolResult(unwrappedResult) ? unwrappedResult : null;
  }, [unwrappedResult]);

  const errorResult = useMemo(() => {
    return isToolErrorResult(unwrappedResult) ? unwrappedResult : null;
  }, [unwrappedResult]);

  const [planContent, setPlanContent] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    setPlanContent(null);
    setPlanError(null);
  }, [props.toolCallId]);

  useEffect(() => {
    if (legacyArgs) {
      return;
    }

    if (props.status !== "completed") {
      return;
    }

    if (!successResult) {
      return;
    }

    // Back-compat: some tool calls may include planContent inline
    if (
      typeof successResult.planContent === "string" &&
      successResult.planContent.trim().length > 0
    ) {
      setPlanContent(successResult.planContent);
      return;
    }

    if (!props.workspaceId) {
      setPlanError("Plan saved, but workspaceId is missing so content can't be fetched.");
      return;
    }

    let cancelled = false;

    (async () => {
      const result = await client.workspace.getPlanContent({ workspaceId: props.workspaceId! });
      if (cancelled) {
        return;
      }

      if (!result.success) {
        setPlanError(result.error ?? "Failed to load plan content");
        return;
      }

      setPlanContent(result.data.content);
    })().catch((err) => {
      if (!cancelled) {
        setPlanError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [client, legacyArgs, props.status, props.workspaceId, successResult]);

  // Legacy tool calls (old sessions) have title + plan inline
  if (legacyArgs) {
    const onStartHere = props.onStartHere;
    const handleStartHereWithPlan = onStartHere
      ? async () => {
          const fullContent = `# ${legacyArgs.title}\n\n${legacyArgs.plan}`;
          await onStartHere(fullContent);
        }
      : undefined;

    return (
      <ProposePlanCard
        title={legacyArgs.title}
        plan={legacyArgs.plan}
        status={props.status}
        workspaceId={props.workspaceId}
        onStartHere={handleStartHereWithPlan}
      />
    );
  }

  if (errorResult) {
    return (
      <Surface variant="plain" style={{ padding: 12, marginBottom: 12 }}>
        <ThemedText weight="semibold">propose_plan failed</ThemedText>
        <ThemedText variant="mono" style={{ marginTop: 8 }}>
          {errorResult.error}
        </ThemedText>
      </Surface>
    );
  }

  if (props.status !== "completed") {
    return (
      <Surface variant="plain" style={{ padding: 12, marginBottom: 12 }}>
        <ThemedText weight="semibold">propose_plan</ThemedText>
        <ThemedText variant="caption" style={{ marginTop: 8 }}>
          Waiting for plan…
        </ThemedText>
      </Surface>
    );
  }

  if (!successResult) {
    return (
      <Surface variant="plain" style={{ padding: 12, marginBottom: 12 }}>
        <ThemedText weight="semibold">propose_plan</ThemedText>
        <ThemedText variant="caption" style={{ marginTop: 8 }}>
          (No result)
        </ThemedText>
      </Surface>
    );
  }

  if (planError) {
    return (
      <Surface variant="plain" style={{ padding: 12, marginBottom: 12 }}>
        <ThemedText weight="semibold">propose_plan</ThemedText>
        <ThemedText variant="mono" style={{ marginTop: 8 }}>
          {planError}
        </ThemedText>
      </Surface>
    );
  }

  if (!planContent) {
    return (
      <Surface variant="plain" style={{ padding: 12, marginBottom: 12 }}>
        <ThemedText weight="semibold">propose_plan</ThemedText>
        <ThemedText variant="caption" style={{ marginTop: 8 }}>
          Loading plan…
        </ThemedText>
      </Surface>
    );
  }

  const title =
    extractTitleFromMarkdown(planContent) ?? successResult.planPath.split("/").pop() ?? "Plan";

  const onStartHere = props.onStartHere;
  const handleStartHereWithPlan = onStartHere
    ? async () => {
        const fullContent = /^#\s+/m.test(planContent)
          ? planContent
          : `# ${title}\n\n${planContent}`;
        await onStartHere(fullContent);
      }
    : undefined;

  return (
    <View>
      <ProposePlanCard
        title={title}
        plan={planContent}
        status={props.status}
        workspaceId={props.workspaceId}
        onStartHere={handleStartHereWithPlan}
      />
    </View>
  );
}
