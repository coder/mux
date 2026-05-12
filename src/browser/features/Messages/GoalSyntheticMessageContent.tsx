import type { ReactElement } from "react";
import { CircleStop, Target } from "lucide-react";

type GoalSyntheticMessageKind = "continuation" | "budget-limit";

interface GoalSyntheticMessageContentProps {
  content: string;
  kind: GoalSyntheticMessageKind;
}

const OBJECTIVE_OPEN_TAG = "<untrusted_objective>";
const OBJECTIVE_CLOSE_TAG = "</untrusted_objective>";

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function extractObjective(content: string): string | null {
  const objectiveStart = content.indexOf(OBJECTIVE_OPEN_TAG);
  if (objectiveStart === -1) return null;

  const valueStart = objectiveStart + OBJECTIVE_OPEN_TAG.length;
  const objectiveEnd = content.indexOf(OBJECTIVE_CLOSE_TAG, valueStart);
  if (objectiveEnd === -1) return null;

  const objective = content.slice(valueStart, objectiveEnd).trim();
  return objective.length > 0 ? decodeXmlEntities(objective) : null;
}

function extractLimitReason(content: string): string | null {
  const [reason = ""] = content.split("\n\n", 1);
  return reason.trim() || null;
}

export function GoalSyntheticMessageContent(props: GoalSyntheticMessageContentProps): ReactElement {
  const objective = extractObjective(props.content);
  let title = "Continuing active goal";
  let description = "Mux is taking the next step automatically.";
  let Icon: typeof Target = Target;

  if (props.kind === "budget-limit") {
    title = "Goal limit reached";
    description = extractLimitReason(props.content) ?? "Mux is wrapping up the current goal.";
    Icon = CircleStop;
  }

  return (
    <section className="bg-muted/10 max-w-[42rem] min-w-[18rem] rounded-md border border-[var(--color-user-border)] p-3 not-italic">
      <div className="flex items-start gap-3">
        <div className="bg-muted/20 text-muted mt-0.5 rounded-md p-1.5">
          <Icon aria-hidden="true" className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="text-sm font-medium text-[var(--color-user-text)]">{title}</div>
            <div className="text-muted mt-0.5 text-xs">{description}</div>
          </div>
          {objective && (
            <blockquote className="border-l-2 border-[var(--color-user-border)] pl-3 text-sm leading-relaxed whitespace-pre-wrap text-[var(--color-user-text)]">
              {objective}
            </blockquote>
          )}
        </div>
      </div>
    </section>
  );
}
